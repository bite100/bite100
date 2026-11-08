package match

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"strings"
	"sync"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// EIP-712 订单签名统一规范（唯一事实源：docs/eip712-order-spec.md）。
// 前端 orderSigningTypes.ts、节点（本文件）、合约 Settlement.sol 三方必须一致：
//   - 域：name="比特100"，version="1"，chainId 与 verifyingContract（Settlement 地址）随部署链；
//     域类型为四字段 EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
//   - Order 结构含 nonce（签名者的链上结算 nonce）与 side（阶段 3 新增，
//     uint8 末位，0=buy/1=sell），字段顺序即编码顺序
//   - amountOut = amountIn * price / 1e18（price 为 1e18 定点缩放）
//
// 默认域为 Sepolia 当前部署配置（2026-11-07 第十五轮 Settlement）；节点启动时
// cmd/node 会用配置文件 chain.chain_id / chain.settlement 调用 SetDomain 覆盖，
// 本地链（如 anvil）与未来第二条链均走配置，不再写死在代码里。

var (
	domainMu         sync.RWMutex
	domainChainID    = big.NewInt(11155111) // Sepolia
	domainContract   = common.HexToAddress("0x929ceb054B86Bf222eb94Df7b75aDa4fD22A538A")
	domainName       = "比特100"
	domainVersionStr = "1"
)

// SetDomain 覆盖签名域参数（本地链/测试用）；chainID 为 nil 或地址为零值时保持原值
func SetDomain(chainID *big.Int, verifyingContract common.Address) {
	domainMu.Lock()
	defer domainMu.Unlock()
	if chainID != nil {
		domainChainID = new(big.Int).Set(chainID)
	}
	if verifyingContract != (common.Address{}) {
		domainContract = verifyingContract
	}
}

// CurrentDomain 返回当前签名域
func CurrentDomain() apitypes.TypedDataDomain {
	domainMu.RLock()
	defer domainMu.RUnlock()
	return apitypes.TypedDataDomain{
		Name:              domainName,
		Version:           domainVersionStr,
		ChainId:           math.NewHexOrDecimal256(domainChainID.Int64()),
		VerifyingContract: domainContract.Hex(),
	}
}

var domainTypeFields = []apitypes.Type{
	{Name: "name", Type: "string"},
	{Name: "version", Type: "string"},
	{Name: "chainId", Type: "uint256"},
	{Name: "verifyingContract", Type: "address"},
}

// 订单方向（阶段 3 Route A，docs/eip712-order-spec.md §2）：side 进入
// EIP-712 签名结构（uint8，置于末尾），0=buy、1=sell，与合约
// Settlement.SIDE_BUY / SIDE_SELL 及 Vault 同口径。
const (
	SideBuy  uint8 = 0
	SideSell uint8 = 1
)

// invalidSideValue 为未知订单簿 side 字符串的 fail-closed 哨兵：BuildSignedOrder
// 对 buy/sell 之外的值映射到此非法值，使验签路径（VerifySignedOrder 显式拒绝
// Side ∉ {0,1}）必然失败——绝不默认成 0/buy 让未知方向混入簿或冒充买单验签。
const invalidSideValue uint8 = 0xff

// SideFromOrderSide 把订单簿方向字符串映射为签名 side 值；未知值返回错误。
func SideFromOrderSide(side string) (uint8, error) {
	switch side {
	case "buy":
		return SideBuy, nil
	case "sell":
		return SideSell, nil
	default:
		return invalidSideValue, fmt.Errorf("unknown order side %q", side)
	}
}

// ValidSignedSide 判断签名 side 值是否合法（仅 0/1）。
func ValidSignedSide(side uint8) bool {
	return side == SideBuy || side == SideSell
}

var orderTypes = apitypes.Types{
	"EIP712Domain": domainTypeFields,
	"Order": {
		{Name: "orderId", Type: "string"},
		{Name: "userAddress", Type: "address"},
		{Name: "tokenIn", Type: "address"},
		{Name: "tokenOut", Type: "address"},
		{Name: "amountIn", Type: "uint256"},
		{Name: "amountOut", Type: "uint256"},
		{Name: "price", Type: "uint256"},
		{Name: "timestamp", Type: "uint256"},
		{Name: "expiresAt", Type: "uint256"},
		{Name: "nonce", Type: "uint256"},
		{Name: "side", Type: "uint8"},
	},
}

var cancelTypes = apitypes.Types{
	"EIP712Domain": domainTypeFields,
	"CancelOrder": {
		{Name: "orderId", Type: "string"},
		{Name: "userAddress", Type: "address"},
		{Name: "timestamp", Type: "uint256"},
	},
}

var scale1e18 = new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)

// DeriveAmountOut 按统一公式派生 amountOut = amountIn * price / 1e18（整数除法）
func DeriveAmountOut(amountIn, price *big.Int) *big.Int {
	return new(big.Int).Div(new(big.Int).Mul(amountIn, price), scale1e18)
}

// BuildSignedOrder 把订单簿订单（storage.Order）映射为统一规范的签名订单表示。
// tokenIn/tokenOut 恒为交易对 (Token0, Token1)（与买卖方向无关，前端下单同此约定）；
// amountOut 按统一公式由 Amount 与 Price 派生；expiresAt 缺省为 CreatedAt + 7 天（与历史行为一致）。
// side 由 order.Side 映射（buy→0、sell→1）；未知值映射为非法哨兵
// invalidSideValue，验签/接单路径据此 fail-closed 拒绝（见 VerifySignedOrder），
// 不在此默认成 buy——否则攻击者可签 buy 单却以非法 side 字符串入簿冒充卖盘。
func BuildSignedOrder(order *storage.Order, pairTokens *PairTokens) *storage.SignedOrder {
	amountIn := new(big.Int)
	amountIn.SetString(order.Amount, 10)
	price := new(big.Int)
	price.SetString(order.Price, 10)

	tokenIn, tokenOut := "", ""
	if pairTokens != nil {
		tokenIn = pairTokens.Token0
		tokenOut = pairTokens.Token1
	}

	expiresAt := order.ExpiresAt
	if expiresAt == 0 {
		expiresAt = order.CreatedAt + 7*24*3600
	}

	side, err := SideFromOrderSide(order.Side)
	if err != nil {
		side = invalidSideValue
	}

	return &storage.SignedOrder{
		OrderID:     order.OrderID,
		UserAddress: order.Trader,
		TokenIn:     tokenIn,
		TokenOut:    tokenOut,
		AmountIn:    amountIn.String(),
		AmountOut:   DeriveAmountOut(amountIn, price).String(),
		Price:       price.String(),
		Timestamp:   order.CreatedAt,
		ExpiresAt:   expiresAt,
		Nonce:       order.Nonce,
		Side:        side,
		Signature:   order.Signature,
	}
}

func orderTypedData(so *storage.SignedOrder) apitypes.TypedData {
	return apitypes.TypedData{
		Types:       orderTypes,
		PrimaryType: "Order",
		Domain:      CurrentDomain(),
		Message: apitypes.TypedDataMessage{
			"orderId":     so.OrderID,
			"userAddress": so.UserAddress,
			"tokenIn":     so.TokenIn,
			"tokenOut":    so.TokenOut,
			"amountIn":    so.AmountIn,
			"amountOut":   so.AmountOut,
			"price":       so.Price,
			"timestamp":   fmt.Sprintf("%d", so.Timestamp),
			"expiresAt":   fmt.Sprintf("%d", so.ExpiresAt),
			"nonce":       fmt.Sprintf("%d", so.Nonce),
			"side":        fmt.Sprintf("%d", so.Side),
		},
	}
}

func typedDataDigest(td apitypes.TypedData, primaryType string) (common.Hash, error) {
	structHash, err := td.HashStruct(primaryType, td.Message)
	if err != nil {
		return common.Hash{}, err
	}
	domainHash, err := td.HashStruct("EIP712Domain", td.Domain.Map())
	if err != nil {
		return common.Hash{}, err
	}
	raw := append([]byte{0x19, 0x01}, domainHash...)
	raw = append(raw, structHash...)
	return crypto.Keccak256Hash(raw), nil
}

// OrderDigest 计算签名订单的 EIP-712 摘要（与合约 Settlement.orderDigest 一致）
func OrderDigest(so *storage.SignedOrder) (common.Hash, error) {
	return typedDataDigest(orderTypedData(so), "Order")
}

// SignOrder 用给定私钥对签名订单签名，返回 0x 前缀的 65 字节签名（v 为 27/28）
func SignOrder(key *ecdsa.PrivateKey, so *storage.SignedOrder) (string, error) {
	digest, err := OrderDigest(so)
	if err != nil {
		return "", err
	}
	sig, err := crypto.Sign(digest.Bytes(), key)
	if err != nil {
		return "", err
	}
	sig[64] += 27
	return hexutil.Encode(sig), nil
}

// SignCancelOrder 对撤单请求签名（与 VerifyCancelSignature 配对；此前只有
// 验签没有签名入口，脚本化撤单——如释放结算失败订单的锁定——只能手写 EIP-712）。
func SignCancelOrder(key *ecdsa.PrivateKey, orderID, userAddress string, timestamp int64) (string, error) {
	typedData := apitypes.TypedData{
		Types:       cancelTypes,
		PrimaryType: "CancelOrder",
		Domain:      CurrentDomain(),
		Message: apitypes.TypedDataMessage{
			"orderId":     orderID,
			"userAddress": userAddress,
			"timestamp":   fmt.Sprintf("%d", timestamp),
		},
	}
	digest, err := typedDataDigest(typedData, "CancelOrder")
	if err != nil {
		return "", err
	}
	sig, err := crypto.Sign(digest.Bytes(), key)
	if err != nil {
		return "", err
	}
	sig[64] += 27
	return hexutil.Encode(sig), nil
}

// VerifySignedOrder 验证签名订单：恢复签名者并与 UserAddress 比对。
// side 非法（∉ {0,1}）先行 fail-closed 拒绝（阶段 3：与合约 Settlement/Vault
// 的 invalid side 拒绝同口径），不进入摘要计算。
func VerifySignedOrder(so *storage.SignedOrder) (bool, error) {
	if !ValidSignedSide(so.Side) {
		return false, fmt.Errorf("invalid side %d", so.Side)
	}
	if so.Signature == "" {
		return false, fmt.Errorf("missing signature")
	}
	digest, err := OrderDigest(so)
	if err != nil {
		return false, err
	}
	sig := common.FromHex(so.Signature)
	if len(sig) != 65 {
		return false, fmt.Errorf("invalid signature length: %d", len(sig))
	}
	if sig[64] >= 27 {
		sig[64] -= 27
	}
	pubKey, err := crypto.SigToPub(digest.Bytes(), sig)
	if err != nil {
		return false, err
	}
	recovered := crypto.PubkeyToAddress(*pubKey)
	return recovered == common.HexToAddress(so.UserAddress), nil
}

// VerifyOrderSignature 验证订单簿订单的签名（统一规范）：先映射为签名订单再验签。
// 订单簿 side 字符串非法（非 buy/sell）先行 fail-closed 拒绝——验签路径不接受
// 未知方向（BuildSignedOrder 对其映射非法哨兵，VerifySignedOrder 亦会拒绝，
// 此处显式拦截使错误口径清晰且不依赖摘要比对）。
func VerifyOrderSignature(order *storage.Order, pairTokens *PairTokens) (bool, error) {
	if _, err := SideFromOrderSide(order.Side); err != nil {
		return false, err
	}
	if order.Signature == "" {
		return false, fmt.Errorf("missing signature")
	}
	return VerifySignedOrder(BuildSignedOrder(order, pairTokens))
}

// ---------- ERC-1271 链上验签（第二十七轮：合约用户，如做市金库） ----------
//
// 纯 ecrecover 只能验 EOA 签名——userAddress 为合约（MakerVault）时，签名者是
// 金库登记的签名者 EOA，恢复地址 ≠ userAddress，纯验签必为 false。链上回退：
// 先查 userAddress 是否有代码，无代码直接 false；有代码则 eth_call
// Settlement.verifyOrderSignature（与 Vault 落锁/结算同一验签口径，EOA 与
// ERC-1271 统一处理）。本函数只在纯验签失败后由 API 调用（合约用户极少，
// 不影响 EOA 的快路径）；RPC 不可用时返回错误、调用方 fail-closed。

const verifyOrderSigABIJSON = `[{"type":"function","name":"verifyOrderSignature","inputs":[{"name":"order","type":"tuple","components":[{"name":"orderId","type":"string"},{"name":"userAddress","type":"address"},{"name":"tokenIn","type":"address"},{"name":"tokenOut","type":"address"},{"name":"amountIn","type":"uint256"},{"name":"amountOut","type":"uint256"},{"name":"price","type":"uint256"},{"name":"timestamp","type":"uint256"},{"name":"expiresAt","type":"uint256"},{"name":"nonce","type":"uint256"},{"name":"side","type":"uint8"}]},{"name":"signature","type":"bytes"}],"outputs":[{"name":"","type":"bool"}],"stateMutability":"view"}]`

const isValidSignatureABIJSON = `[{"type":"function","name":"isValidSignature","inputs":[{"name":"hash","type":"bytes32"},{"name":"signature","type":"bytes"}],"outputs":[{"name":"magicValue","type":"bytes4"}],"stateMutability":"view"}]`

// erc1271MagicValue 为 EIP-1271 成功返回值 0x1626ba7e
var erc1271MagicValue = [4]byte{0x16, 0x26, 0xba, 0x7e}

// abiOrder 为 ABI 编码用的订单结构（与合约 Settlement.Order 字段一一对应；
// side 为阶段 3 新增末位字段，uint8）
type abiOrder struct {
	OrderId     string         `abi:"orderId"`
	UserAddress common.Address `abi:"userAddress"`
	TokenIn     common.Address `abi:"tokenIn"`
	TokenOut    common.Address `abi:"tokenOut"`
	AmountIn    *big.Int       `abi:"amountIn"`
	AmountOut   *big.Int       `abi:"amountOut"`
	Price       *big.Int       `abi:"price"`
	Timestamp   *big.Int       `abi:"timestamp"`
	ExpiresAt   *big.Int       `abi:"expiresAt"`
	Nonce       *big.Int       `abi:"nonce"`
	Side        uint8          `abi:"side"`
}

func signedOrderToABIOrder(so *storage.SignedOrder) abiOrder {
	dec := func(s string) *big.Int {
		v, ok := new(big.Int).SetString(s, 10)
		if !ok {
			return big.NewInt(0)
		}
		return v
	}
	return abiOrder{
		OrderId:     so.OrderID,
		UserAddress: common.HexToAddress(so.UserAddress),
		TokenIn:     common.HexToAddress(so.TokenIn),
		TokenOut:    common.HexToAddress(so.TokenOut),
		AmountIn:    dec(so.AmountIn),
		AmountOut:   dec(so.AmountOut),
		Price:       dec(so.Price),
		Timestamp:   big.NewInt(so.Timestamp),
		ExpiresAt:   big.NewInt(so.ExpiresAt),
		Nonce:       big.NewInt(so.Nonce),
		Side:        so.Side,
	}
}

// VerifySignedOrderOnChain 对签名订单做链上验签：纯验签先行（EOA 快路径）；
// 纯验签失败且 userAddress 有代码时，调 Settlement.verifyOrderSignature 兜底。
// 返回 (false, nil) = 签名无效；(false, err) = 链上查询失败（调用方应 fail-closed）。
func VerifySignedOrderOnChain(ctx context.Context, rpcURL, settlementAddr string, so *storage.SignedOrder) (bool, error) {
	// side 非法先行拒绝：链上 verifyOrderSignature 只验签名与摘要的对应关系、
	// 不判 side 合法性（合法性由结算/落锁入口强制），节点侧不得让非法 side
	// 经 1271 兜底路径混入（fail-closed，与 VerifySignedOrder 同口径）。
	if !ValidSignedSide(so.Side) {
		return false, fmt.Errorf("invalid side %d", so.Side)
	}
	if ok, err := VerifySignedOrder(so); err == nil && ok {
		return true, nil
	}
	if rpcURL == "" || settlementAddr == "" {
		return false, nil
	}
	client, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return false, fmt.Errorf("dial rpc: %w", err)
	}
	defer client.Close()
	user := common.HexToAddress(so.UserAddress)
	code, err := client.CodeAt(ctx, user, nil)
	if err != nil {
		return false, fmt.Errorf("code at user: %w", err)
	}
	if len(code) == 0 {
		return false, nil // EOA 且纯验签已失败：签名无效
	}
	parsed, err := abi.JSON(strings.NewReader(verifyOrderSigABIJSON))
	if err != nil {
		return false, err
	}
	data, err := parsed.Pack("verifyOrderSignature", signedOrderToABIOrder(so), common.FromHex(so.Signature))
	if err != nil {
		return false, err
	}
	to := common.HexToAddress(settlementAddr)
	out, err := client.CallContract(ctx, ethereum.CallMsg{To: &to, Data: data}, nil)
	if err != nil {
		return false, fmt.Errorf("call verifyOrderSignature: %w", err)
	}
	var valid bool
	if err := parsed.UnpackIntoInterface(&valid, "verifyOrderSignature", out); err != nil {
		return false, err
	}
	return valid, nil
}

// VerifyOrderSignatureOnChain 为订单簿订单的链上验签入口（API 层用）
func VerifyOrderSignatureOnChain(ctx context.Context, rpcURL, settlementAddr string, order *storage.Order, pairTokens *PairTokens) (bool, error) {
	if order.Signature == "" {
		return false, fmt.Errorf("missing signature")
	}
	return VerifySignedOrderOnChain(ctx, rpcURL, settlementAddr, BuildSignedOrder(order, pairTokens))
}

// VerifyCancelSignatureOnChain 对撤单签名做链上验签：纯验签先行；失败且用户
// 为合约时，调该合约的 isValidSignature（CancelOrder 摘要）兜底。
func VerifyCancelSignatureOnChain(ctx context.Context, rpcURL, orderID, userAddress, signature string, timestamp int64) (bool, error) {
	if ok, err := VerifyCancelSignature(orderID, userAddress, signature, timestamp); err == nil && ok {
		return true, nil
	}
	if rpcURL == "" {
		return false, nil
	}
	typedData := apitypes.TypedData{
		Types:       cancelTypes,
		PrimaryType: "CancelOrder",
		Domain:      CurrentDomain(),
		Message: apitypes.TypedDataMessage{
			"orderId":     orderID,
			"userAddress": userAddress,
			"timestamp":   fmt.Sprintf("%d", timestamp),
		},
	}
	digest, err := typedDataDigest(typedData, "CancelOrder")
	if err != nil {
		return false, err
	}
	client, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return false, fmt.Errorf("dial rpc: %w", err)
	}
	defer client.Close()
	user := common.HexToAddress(userAddress)
	code, err := client.CodeAt(ctx, user, nil)
	if err != nil {
		return false, fmt.Errorf("code at user: %w", err)
	}
	if len(code) == 0 {
		return false, nil
	}
	parsed, err := abi.JSON(strings.NewReader(isValidSignatureABIJSON))
	if err != nil {
		return false, err
	}
	data, err := parsed.Pack("isValidSignature", digest, common.FromHex(signature))
	if err != nil {
		return false, err
	}
	out, err := client.CallContract(ctx, ethereum.CallMsg{To: &user, Data: data}, nil)
	if err != nil {
		return false, fmt.Errorf("call isValidSignature: %w", err)
	}
	if len(out) < 4 {
		return false, nil
	}
	return [4]byte(out[:4]) == erc1271MagicValue, nil
}

// VerifyCancelSignature 验证取消订单签名（与订单共用同一签名域）
func VerifyCancelSignature(orderID, userAddress, signature string, timestamp int64) (bool, error) {
	if signature == "" {
		return false, fmt.Errorf("missing signature")
	}

	typedData := apitypes.TypedData{
		Types:       cancelTypes,
		PrimaryType: "CancelOrder",
		Domain:      CurrentDomain(),
		Message: apitypes.TypedDataMessage{
			"orderId":     orderID,
			"userAddress": userAddress,
			"timestamp":   fmt.Sprintf("%d", timestamp),
		},
	}

	digest, err := typedDataDigest(typedData, "CancelOrder")
	if err != nil {
		return false, err
	}

	sig := common.FromHex(signature)
	if len(sig) != 65 {
		return false, fmt.Errorf("invalid signature length")
	}
	if sig[64] >= 27 {
		sig[64] -= 27
	}

	pubKey, err := crypto.SigToPub(digest.Bytes(), sig)
	if err != nil {
		return false, err
	}

	recoveredAddr := crypto.PubkeyToAddress(*pubKey)
	expectedAddr := common.HexToAddress(userAddress)

	return recoveredAddr == expectedAddr, nil
}
