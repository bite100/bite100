package settlement

// 挂单余额锁定（第十五轮，设计见 docs/order-balance-locking.md）。
//
// 节点在订单被接受进订单簿时驱动 Vault 落锁：先按订单方向算义务
// （卖方 = tokenIn × amountIn；买方 = tokenOut × amountOut——签名订单是
// 交易对朝向的，方向只在订单簿 Side 字段里），校验可用余额
// （balanceOf − locked）后以 locker 身份调用 Vault.lockForOrder；
// Vault 验签并从订单本身派生锁定量，节点无法虚增。撤单时按订单摘要
// 释放剩余锁定；成交的锁定消耗由 Settlement 结算时在链上完成，节点
// 不参与。过期订单的剩余锁定任何人可释放（Vault.releaseExpiredOrderLock），
// 节点不做定时清理。
//
// locker 私钥经参数传入（调用方从环境变量 VAULT_LOCKER_PRIVATE_KEY 读取），
// 不落配置文件。测试网阶段 locker = 部署/运营身份；主网须换成经治理
// 授权的中继集合（设计文档 §3）。

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

const vaultLockABIJSON = `[
  {"inputs":[{"components":[{"internalType":"string","name":"orderId","type":"string"},{"internalType":"address","name":"userAddress","type":"address"},{"internalType":"address","name":"tokenIn","type":"address"},{"internalType":"address","name":"tokenOut","type":"address"},{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOut","type":"uint256"},{"internalType":"uint256","name":"price","type":"uint256"},{"internalType":"uint256","name":"timestamp","type":"uint256"},{"internalType":"uint256","name":"expiresAt","type":"uint256"},{"internalType":"uint256","name":"nonce","type":"uint256"}],"internalType":"struct IVaultOrder","name":"order","type":"tuple"},{"internalType":"bytes","name":"signature","type":"bytes"},{"internalType":"bool","name":"payWithTokenIn","type":"bool"}],"name":"lockForOrder","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"digest","type":"bytes32"}],"name":"releaseOrderLock","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"user","type":"address"},{"internalType":"address","name":"token","type":"address"}],"name":"locked","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"user","type":"address"},{"internalType":"address","name":"token","type":"address"}],"name":"availableBalance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"token","type":"address"},{"internalType":"address","name":"user","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
]`

const settlementDigestABIJSON = `[
  {"inputs":[{"components":[{"internalType":"string","name":"orderId","type":"string"},{"internalType":"address","name":"userAddress","type":"address"},{"internalType":"address","name":"tokenIn","type":"address"},{"internalType":"address","name":"tokenOut","type":"address"},{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOut","type":"uint256"},{"internalType":"uint256","name":"price","type":"uint256"},{"internalType":"uint256","name":"timestamp","type":"uint256"},{"internalType":"uint256","name":"expiresAt","type":"uint256"},{"internalType":"uint256","name":"nonce","type":"uint256"}],"internalType":"struct IOrderDigest","name":"order","type":"tuple"}],"name":"orderDigest","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"pure","type":"function"}
]`

var (
	vaultLockABI      abi.ABI
	settlementDigABI  abi.ABI
)

func init() {
	var err error
	vaultLockABI, err = abi.JSON(strings.NewReader(vaultLockABIJSON))
	if err != nil {
		panic(err)
	}
	settlementDigABI, err = abi.JSON(strings.NewReader(settlementDigestABIJSON))
	if err != nil {
		panic(err)
	}
}

// ObligationForOrder 按订单方向返回付款义务（token, amount, payWithTokenIn）。
// side 取订单簿方向："sell" 付 tokenIn、"buy" 付 tokenOut。
func ObligationForOrder(so *storage.SignedOrder, side string) (common.Address, *big.Int, bool, error) {
	if so == nil {
		return common.Address{}, nil, false, fmt.Errorf("signed order is nil")
	}
	switch side {
	case "sell":
		amt, ok := new(big.Int).SetString(so.AmountIn, 10)
		if !ok {
			return common.Address{}, nil, false, fmt.Errorf("bad amountIn %q", so.AmountIn)
		}
		return common.HexToAddress(so.TokenIn), amt, true, nil
	case "buy":
		amt, ok := new(big.Int).SetString(so.AmountOut, 10)
		if !ok {
			return common.Address{}, nil, false, fmt.Errorf("bad amountOut %q", so.AmountOut)
		}
		return common.HexToAddress(so.TokenOut), amt, false, nil
	default:
		return common.Address{}, nil, false, fmt.Errorf("unknown order side %q", side)
	}
}

// OrderDigest 调用 Settlement.orderDigest 计算订单的 EIP-712 摘要（锁定键）。
func OrderDigest(ctx context.Context, client *ethclient.Client, settlementAddr string, so *storage.SignedOrder) (common.Hash, error) {
	to := common.HexToAddress(settlementAddr)
	data, err := settlementDigABI.Pack("orderDigest", signedOrderToABI(so).Order)
	if err != nil {
		return common.Hash{}, err
	}
	out, err := client.CallContract(ctx, ethereum.CallMsg{To: &to, Data: data}, nil)
	if err != nil {
		return common.Hash{}, err
	}
	var digest common.Hash
	if err := settlementDigABI.UnpackIntoInterface(&digest, "orderDigest", out); err != nil {
		// bytes32 返回值直接拷贝兜底
		if len(out) < 32 {
			return common.Hash{}, err
		}
		copy(digest[:], out[:32])
	}
	return digest, nil
}

// OrderDigestByRPC 自行拨号版 OrderDigest（节点主流程用）。
func OrderDigestByRPC(ctx context.Context, rpcURL, settlementAddr string, so *storage.SignedOrder) (common.Hash, error) {
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return common.Hash{}, fmt.Errorf("dial rpc: %w", err)
	}
	defer client.Close()
	return OrderDigest(ctx, client, settlementAddr, so)
}

// VaultBalances 读回某用户某代币的（总余额, 已锁定, 可用）三元组。
func VaultBalances(ctx context.Context, client *ethclient.Client, vaultAddr string, user, token common.Address) (balance, locked, available *big.Int, err error) {
	to := common.HexToAddress(vaultAddr)
	read := func(method string, args ...interface{}) (*big.Int, error) {
		data, err := vaultLockABI.Pack(method, args...)
		if err != nil {
			return nil, err
		}
		out, err := client.CallContract(ctx, ethereum.CallMsg{To: &to, Data: data}, nil)
		if err != nil {
			return nil, err
		}
		res, err := vaultLockABI.Unpack(method, out)
		if err != nil {
			return nil, err
		}
		if len(res) != 1 {
			return nil, fmt.Errorf("%s: unexpected outputs %d", method, len(res))
		}
		v, ok := res[0].(*big.Int)
		if !ok {
			return nil, fmt.Errorf("%s: unexpected type %T", method, res[0])
		}
		return v, nil
	}
	if balance, err = read("balanceOf", token, user); err != nil {
		return nil, nil, nil, err
	}
	if locked, err = read("locked", user, token); err != nil {
		return nil, nil, nil, err
	}
	if available, err = read("availableBalance", user, token); err != nil {
		return nil, nil, nil, err
	}
	return balance, locked, available, nil
}

func sendVaultTx(ctx context.Context, rpcURL, vaultAddr, privateKeyHex string, data []byte) (string, error) {
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return "", fmt.Errorf("dial rpc: %w", err)
	}
	defer client.Close()
	keyHex := strings.TrimPrefix(privateKeyHex, "0x")
	priv, err := crypto.HexToECDSA(keyHex)
	if err != nil {
		return "", fmt.Errorf("parse private key: %w", err)
	}
	from := crypto.PubkeyToAddress(priv.PublicKey)
	chainID, err := client.ChainID(ctx)
	if err != nil {
		return "", fmt.Errorf("chain id: %w", err)
	}
	nonce, err := client.PendingNonceAt(ctx, from)
	if err != nil {
		return "", fmt.Errorf("nonce: %w", err)
	}
	gasPrice, err := client.SuggestGasPrice(ctx)
	if err != nil {
		return "", fmt.Errorf("gas price: %w", err)
	}
	to := common.HexToAddress(vaultAddr)
	tx := types.NewTx(&types.LegacyTx{
		Nonce:    nonce,
		To:       &to,
		Value:    big.NewInt(0),
		Gas:      600_000,
		GasPrice: gasPrice,
		Data:     data,
	})
	signed, err := types.SignTx(tx, types.NewEIP155Signer(chainID), priv)
	if err != nil {
		return "", fmt.Errorf("sign tx: %w", err)
	}
	if err := client.SendTransaction(ctx, signed); err != nil {
		return "", fmt.Errorf("send tx: %w", err)
	}
	deadline := time.Now().Add(3 * time.Minute)
	for time.Now().Before(deadline) {
		receipt, err := client.TransactionReceipt(ctx, signed.Hash())
		if err == nil {
			if receipt.Status != types.ReceiptStatusSuccessful {
				return signed.Hash().Hex(), fmt.Errorf("tx reverted: %s", signed.Hash().Hex())
			}
			return signed.Hash().Hex(), nil
		}
		time.Sleep(3 * time.Second)
	}
	return signed.Hash().Hex(), fmt.Errorf("tx receipt timeout: %s", signed.Hash().Hex())
}

// LockOrder 以 locker 身份为签名订单落锁：落锁前先校验可用余额覆盖义务量
// （不足直接报错、不发交易；Vault 落锁时还会再验一次）。返回订单摘要与交易哈希。
func LockOrder(ctx context.Context, rpcURL, vaultAddr, settlementAddr, lockerKeyHex string, so *storage.SignedOrder, side string) (common.Hash, string, error) {
	token, amount, payWithTokenIn, err := ObligationForOrder(so, side)
	if err != nil {
		return common.Hash{}, "", err
	}
	if so.Signature == "" {
		return common.Hash{}, "", fmt.Errorf("order %s has no signature", so.OrderID)
	}
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return common.Hash{}, "", fmt.Errorf("dial rpc: %w", err)
	}
	defer client.Close()
	user := common.HexToAddress(so.UserAddress)
	_, _, available, err := VaultBalances(ctx, client, vaultAddr, user, token)
	if err != nil {
		return common.Hash{}, "", fmt.Errorf("read vault balances: %w", err)
	}
	if available.Cmp(amount) < 0 {
		return common.Hash{}, "", fmt.Errorf("insufficient available balance: need %s, available %s (user %s token %s)", amount, available, so.UserAddress, token.Hex())
	}
	digest, err := OrderDigest(ctx, client, settlementAddr, so)
	if err != nil {
		return common.Hash{}, "", fmt.Errorf("order digest: %w", err)
	}
	sigBytes := common.FromHex(so.Signature)
	data, err := vaultLockABI.Pack("lockForOrder", signedOrderToABI(so).Order, sigBytes, payWithTokenIn)
	if err != nil {
		return common.Hash{}, "", fmt.Errorf("pack lockForOrder: %w", err)
	}
	txHash, err := sendVaultTx(ctx, rpcURL, vaultAddr, lockerKeyHex, data)
	if err != nil {
		return digest, "", err
	}
	return digest, txHash, nil
}

// ReleaseOrderLock 以 locker 身份按订单摘要释放剩余锁定（撤单路径）。
// 锁定已被结算全部消费时 Vault 会 revert，调用方应只记日志不阻断撤单。
func ReleaseOrderLock(ctx context.Context, rpcURL, vaultAddr, lockerKeyHex string, digest common.Hash) (string, error) {
	data, err := vaultLockABI.Pack("releaseOrderLock", digest)
	if err != nil {
		return "", fmt.Errorf("pack releaseOrderLock: %w", err)
	}
	return sendVaultTx(ctx, rpcURL, vaultAddr, lockerKeyHex, data)
}
