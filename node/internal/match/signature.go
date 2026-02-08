package match

import (
	"fmt"
	"math/big"
	
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
	
	"github.com/P2P-P2P/p2p/node/internal/storage"
)

var (
	domainSeparator = apitypes.TypedDataDomain{
		Name:    "P2P DEX",
		Version: "1",
		ChainId: math.NewHexOrDecimal256(11155111), // Sepolia
	}
	
	orderTypes = apitypes.Types{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
		},
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
		},
	}
)

// VerifyOrderSignature 验证订单签名（EIP-712）
// pairTokens 为 nil 时，tokenIn/tokenOut 使用空字符串（向后兼容）
func VerifyOrderSignature(order *storage.Order, pairTokens *PairTokens) (bool, error) {
	if order.Signature == "" {
		return false, fmt.Errorf("missing signature")
	}
	
	// 构造 TypedData
	amountIn := new(big.Int)
	amountIn.SetString(order.Amount, 10)
	
	price := new(big.Int)
	price.SetString(order.Price, 10)
	
	// 从 pair 解析 tokenIn/tokenOut
	tokenIn := ""
	tokenOut := ""
	if pairTokens != nil {
		if order.Side == "buy" {
			// 买单：买入 tokenOut（quote），卖出 tokenIn（base）
			tokenIn = pairTokens.Token0
			tokenOut = pairTokens.Token1
		} else {
			// 卖单：卖出 tokenIn（base），买入 tokenOut（quote）
			tokenIn = pairTokens.Token0
			tokenOut = pairTokens.Token1
		}
	}
	
	// 计算 amountOut = amountIn * price（以最小单位计算）
	amountOut := new(big.Int).Mul(amountIn, price)
	
	// expiresAt 从订单的 ExpiresAt 字段获取
	expiresAt := order.ExpiresAt
	if expiresAt == 0 {
		// 如果没有设置过期时间，使用默认值（7天后）
		expiresAt = order.CreatedAt + 7*24*3600
	}
	
	typedData := apitypes.TypedData{
		Types:       orderTypes,
		PrimaryType: "Order",
		Domain:      domainSeparator,
		Message: apitypes.TypedDataMessage{
			"orderId":     order.OrderID,
			"userAddress": order.Trader,
			"tokenIn":     tokenIn,
			"tokenOut":    tokenOut,
			"amountIn":    amountIn.String(),
			"amountOut":   amountOut.String(),
			"price":       price.String(),
			"timestamp":   fmt.Sprintf("%d", order.CreatedAt),
			"expiresAt":   fmt.Sprintf("%d", expiresAt),
		},
	}
	
	// 计算 EIP-712 哈希
	hash, err := typedData.HashStruct("Order", typedData.Message)
	if err != nil {
		return false, err
	}
	
	domainHash, err := typedData.HashStruct("EIP712Domain", typedData.Domain.Map())
	if err != nil {
		return false, err
	}
	
	// \x19\x01 + domainHash + structHash
	rawData := []byte(fmt.Sprintf("\x19\x01%s%s", string(domainHash), string(hash)))
	finalHash := crypto.Keccak256Hash(rawData)
	
	// 解析签名
	sig := common.FromHex(order.Signature)
	if len(sig) != 65 {
		return false, fmt.Errorf("invalid signature length: %d", len(sig))
	}
	
	// 调整 v 值（以太坊签名格式）
	if sig[64] >= 27 {
		sig[64] -= 27
	}
	
	// 恢复公钥
	pubKey, err := crypto.SigToPub(finalHash.Bytes(), sig)
	if err != nil {
		return false, err
	}
	
	// 验证地址
	recoveredAddr := crypto.PubkeyToAddress(*pubKey)
	expectedAddr := common.HexToAddress(order.Trader)
	
	return recoveredAddr == expectedAddr, nil
}

// VerifyCancelSignature 验证取消订单签名
func VerifyCancelSignature(orderID, userAddress, signature string, timestamp int64) (bool, error) {
	if signature == "" {
		return false, fmt.Errorf("missing signature")
	}
	
	cancelTypes := apitypes.Types{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
		},
		"CancelOrder": {
			{Name: "orderId", Type: "string"},
			{Name: "userAddress", Type: "address"},
			{Name: "timestamp", Type: "uint256"},
		},
	}
	
	typedData := apitypes.TypedData{
		Types:       cancelTypes,
		PrimaryType: "CancelOrder",
		Domain:      domainSeparator,
		Message: apitypes.TypedDataMessage{
			"orderId":     orderID,
			"userAddress": userAddress,
			"timestamp":   fmt.Sprintf("%d", timestamp),
		},
	}
	
	hash, err := typedData.HashStruct("CancelOrder", typedData.Message)
	if err != nil {
		return false, err
	}
	
	domainHash, err := typedData.HashStruct("EIP712Domain", typedData.Domain.Map())
	if err != nil {
		return false, err
	}
	
	rawData := []byte(fmt.Sprintf("\x19\x01%s%s", string(domainHash), string(hash)))
	finalHash := crypto.Keccak256Hash(rawData)
	
	sig := common.FromHex(signature)
	if len(sig) != 65 {
		return false, fmt.Errorf("invalid signature length")
	}
	
	if sig[64] >= 27 {
		sig[64] -= 27
	}
	
	pubKey, err := crypto.SigToPub(finalHash.Bytes(), sig)
	if err != nil {
		return false, err
	}
	
	recoveredAddr := crypto.PubkeyToAddress(*pubKey)
	expectedAddr := common.HexToAddress(userAddress)
	
	return recoveredAddr == expectedAddr, nil
}
