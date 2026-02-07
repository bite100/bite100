package settlement

import (
	"context"
	"log"
	"math/big"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// SubmitTrade 向链上 Settlement 合约提交一笔成交（需 Settlement owner 私钥）。
// 当前为占位：仅打日志；实际链上提交可用 contracts 目录下 cast 脚本或 abigen 生成 Go binding 后在此调用。
func SubmitTrade(ctx context.Context, t *storage.Trade, rpcURL, settlementAddr, privateKeyHex string) error {
	if t.Maker == "" || t.Taker == "" || t.TokenIn == "" || t.TokenOut == "" || t.AmountIn == "" || t.AmountOut == "" {
		return nil
	}
	_ = rpcURL
	_ = settlementAddr
	_ = privateKeyHex
	_ = ctx
	log.Printf("[settlement] 成交待链上结算：maker=%s taker=%s tokenIn=%s tokenOut=%s amountIn=%s amountOut=%s（需 Settlement owner 调用 settleTrade）", t.Maker, t.Taker, t.TokenIn, t.TokenOut, t.AmountIn, t.AmountOut)
	return nil
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
