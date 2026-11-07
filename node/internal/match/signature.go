package match

import (
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"sync"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// EIP-712 订单签名统一规范（唯一事实源：docs/eip712-order-spec.md）。
// 前端 orderSigningTypes.ts、节点（本文件）、合约 Settlement.sol 三方必须一致：
//   - 域：name="比特100"，version="1"，chainId 与 verifyingContract（Settlement 地址）随部署链；
//     域类型为四字段 EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
//   - Order 结构含 nonce（签名者的链上结算 nonce），字段顺序即编码顺序
//   - amountOut = amountIn * price / 1e18（price 为 1e18 定点缩放）
//
// 默认域为 Sepolia 已部署配置；本地链（如 anvil）启动时用 SetDomain 覆盖。

var (
	domainMu         sync.RWMutex
	domainChainID    = big.NewInt(11155111) // Sepolia
	domainContract   = common.HexToAddress("0x493Da680973F6c222c89eeC02922E91F1D9404a0")
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

// VerifySignedOrder 验证签名订单：恢复签名者并与 UserAddress 比对
func VerifySignedOrder(so *storage.SignedOrder) (bool, error) {
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

// VerifyOrderSignature 验证订单簿订单的签名（统一规范）：先映射为签名订单再验签
func VerifyOrderSignature(order *storage.Order, pairTokens *PairTokens) (bool, error) {
	if order.Signature == "" {
		return false, fmt.Errorf("missing signature")
	}
	return VerifySignedOrder(BuildSignedOrder(order, pairTokens))
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
