package settlement

import (
	"context"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// 以下结构体与合约 Settlement 的 Order/SignedOrder/Fill 一一对应（字段名以 abi tag 绑定），
// 规范见 docs/eip712-order-spec.md

type Order struct {
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
}

type SignedOrder struct {
	Order     Order  `abi:"order"`
	Signature []byte `abi:"signature"`
}

type Fill struct {
	MakerOrder      SignedOrder    `abi:"makerOrder"`
	TakerOrder      SignedOrder    `abi:"takerOrder"`
	TokenIn         common.Address `abi:"tokenIn"`
	TokenOut        common.Address `abi:"tokenOut"`
	AmountIn        *big.Int       `abi:"amountIn"`
	AmountOut       *big.Int       `abi:"amountOut"`
	GasReimburseIn  *big.Int       `abi:"gasReimburseIn"`
	GasReimburseOut *big.Int       `abi:"gasReimburseOut"`
}

// settlementABIJSON 为 Settlement.settleTrade 的 ABI（自 contracts/out 构建产物提取，随合约接口变更同步更新）
const settlementABIJSON = `[{"type":"function","name":"settleTrade","inputs":[{"name":"fill","type":"tuple","internalType":"struct Settlement.Fill","components":[{"name":"makerOrder","type":"tuple","internalType":"struct Settlement.SignedOrder","components":[{"name":"order","type":"tuple","internalType":"struct Settlement.Order","components":[{"name":"orderId","type":"string","internalType":"string"},{"name":"userAddress","type":"address","internalType":"address"},{"name":"tokenIn","type":"address","internalType":"address"},{"name":"tokenOut","type":"address","internalType":"address"},{"name":"amountIn","type":"uint256","internalType":"uint256"},{"name":"amountOut","type":"uint256","internalType":"uint256"},{"name":"price","type":"uint256","internalType":"uint256"},{"name":"timestamp","type":"uint256","internalType":"uint256"},{"name":"expiresAt","type":"uint256","internalType":"uint256"},{"name":"nonce","type":"uint256","internalType":"uint256"}]},{"name":"signature","type":"bytes","internalType":"bytes"}]},{"name":"takerOrder","type":"tuple","internalType":"struct Settlement.SignedOrder","components":[{"name":"order","type":"tuple","internalType":"struct Settlement.Order","components":[{"name":"orderId","type":"string","internalType":"string"},{"name":"userAddress","type":"address","internalType":"address"},{"name":"tokenIn","type":"address","internalType":"address"},{"name":"tokenOut","type":"address","internalType":"address"},{"name":"amountIn","type":"uint256","internalType":"uint256"},{"name":"amountOut","type":"uint256","internalType":"uint256"},{"name":"price","type":"uint256","internalType":"uint256"},{"name":"timestamp","type":"uint256","internalType":"uint256"},{"name":"expiresAt","type":"uint256","internalType":"uint256"},{"name":"nonce","type":"uint256","internalType":"uint256"}]},{"name":"signature","type":"bytes","internalType":"bytes"}]},{"name":"tokenIn","type":"address","internalType":"address"},{"name":"tokenOut","type":"address","internalType":"address"},{"name":"amountIn","type":"uint256","internalType":"uint256"},{"name":"amountOut","type":"uint256","internalType":"uint256"},{"name":"gasReimburseIn","type":"uint256","internalType":"uint256"},{"name":"gasReimburseOut","type":"uint256","internalType":"uint256"}]}],"outputs":[],"stateMutability":"nonpayable"}]`

var scale1e18 = new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)

func bigDec(s string) *big.Int {
	i, ok := new(big.Int).SetString(s, 10)
	if !ok {
		return big.NewInt(0)
	}
	return i
}

// decimalToInt 把引擎的浮点文本数量（如 "100.000000000000000000"）截断为整数（最小单位）
func decimalToInt(s string) (*big.Int, error) {
	f, ok := new(big.Float).SetString(s)
	if !ok {
		return nil, fmt.Errorf("invalid decimal %q", s)
	}
	i, _ := f.Int(nil)
	return i, nil
}

func signedOrderToABI(so *storage.SignedOrder) SignedOrder {
	return SignedOrder{
		Order: Order{
			OrderId:     so.OrderID,
			UserAddress: common.HexToAddress(so.UserAddress),
			TokenIn:     common.HexToAddress(so.TokenIn),
			TokenOut:    common.HexToAddress(so.TokenOut),
			AmountIn:    bigDec(so.AmountIn),
			AmountOut:   bigDec(so.AmountOut),
			Price:       bigDec(so.Price),
			Timestamp:   big.NewInt(so.Timestamp),
			ExpiresAt:   big.NewInt(so.ExpiresAt),
			Nonce:       big.NewInt(so.Nonce),
		},
		Signature: common.FromHex(so.Signature),
	}
}

// TradeToFill 由成交记录与双方签名订单构造链上 Fill。
// 成交数量以 Trade.Amount（以交易对 Token0 计的成交量）与 maker 签名价格重算真实代币数量：
// Token1 量 = Token0 量 * price / 1e18。不直接采用 Trade.AmountIn/Out——其为引擎内部
// 浮点文本且历史口径与签名公式不一致（amountOut 曾漏除 1e18）。
func TradeToFill(t *storage.Trade) (Fill, error) {
	if t == nil || t.MakerOrder == nil || t.TakerOrder == nil {
		return Fill{}, fmt.Errorf("settlement: trade missing signed orders")
	}
	mo := t.MakerOrder
	qty0, err := decimalToInt(t.Amount)
	if err != nil {
		return Fill{}, fmt.Errorf("settlement: trade amount: %w", err)
	}
	price := bigDec(mo.Price)
	qty1 := new(big.Int).Div(new(big.Int).Mul(qty0, price), scale1e18)

	fill := Fill{
		MakerOrder:      signedOrderToABI(t.MakerOrder),
		TakerOrder:      signedOrderToABI(t.TakerOrder),
		TokenIn:         common.HexToAddress(t.TokenIn),
		TokenOut:        common.HexToAddress(t.TokenOut),
		GasReimburseIn:  big.NewInt(0),
		GasReimburseOut: big.NewInt(0),
	}
	if strings.EqualFold(t.TokenIn, mo.TokenIn) {
		// maker 卖出 Token0
		fill.AmountIn = qty0
		fill.AmountOut = qty1
	} else {
		// maker 买入 Token0、卖出（付出）Token1
		fill.AmountIn = qty1
		fill.AmountOut = qty0
	}
	return fill, nil
}

// SubmitTrade 把一笔成交真实提交到链上 Settlement.settleTrade（验签结算）。
// privateKeyHex 为被授权的结算方（owner 或白名单 relayer）私钥；合约侧将校验双方
// 订单签名、累计成交量与 nonce，提交方只是搬运工。成功后 t.TxHash 被回填并返回；
// 链上 revert 时返回非空 tx hash 与错误。
func SubmitTrade(ctx context.Context, t *storage.Trade, rpcURL, settlementAddr, privateKeyHex string) (string, error) {
	fill, err := TradeToFill(t)
	if err != nil {
		return "", err
	}

	client, err := ethclient.DialContext(ctx, rpcURL)
	if err != nil {
		return "", fmt.Errorf("settlement: dial rpc: %w", err)
	}
	defer client.Close()

	chainID, err := client.ChainID(ctx)
	if err != nil {
		return "", fmt.Errorf("settlement: chain id: %w", err)
	}

	key, err := crypto.HexToECDSA(strings.TrimPrefix(privateKeyHex, "0x"))
	if err != nil {
		return "", fmt.Errorf("settlement: bad private key: %w", err)
	}

	parsed, err := abi.JSON(strings.NewReader(settlementABIJSON))
	if err != nil {
		return "", fmt.Errorf("settlement: parse abi: %w", err)
	}
	contract := bind.NewBoundContract(common.HexToAddress(settlementAddr), parsed, client, client, client)

	opts, err := bind.NewKeyedTransactorWithChainID(key, chainID)
	if err != nil {
		return "", fmt.Errorf("settlement: transactor: %w", err)
	}
	opts.Context = ctx

	tx, err := contract.Transact(opts, "settleTrade", fill)
	if err != nil {
		return "", fmt.Errorf("settlement: submit settleTrade: %w", err)
	}

	receipt, err := bind.WaitMined(ctx, client, tx)
	if err != nil {
		return tx.Hash().Hex(), fmt.Errorf("settlement: wait mined: %w", err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		return tx.Hash().Hex(), fmt.Errorf("settlement: settleTrade reverted on-chain, tx=%s", tx.Hash().Hex())
	}

	t.TxHash = tx.Hash().Hex()
	return t.TxHash, nil
}

// DecimalToWei 将十进制字符串转为 18 位精度的 wei（供链上 amount 使用）
func DecimalToWei(s string) *big.Int {
	f, ok := new(big.Float).SetString(s)
	if !ok {
		return big.NewInt(0)
	}
	scale := new(big.Float).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil))
	f.Mul(f, scale)
	i, _ := f.Int(nil)
	return i
}
