package settlement

// 挂单余额锁定（第十五轮，设计见 docs/order-balance-locking.md）。
//
// 节点在订单被接受进订单簿时驱动 Vault 落锁：先按订单方向算义务
// （卖方 = tokenIn × amountIn；买方 = tokenOut × amountOut——签名订单是
// 交易对朝向的；阶段 3 起方向即签名订单的 side 字段本身，义务与落锁
// 方向都只从 SignedOrder.Side 派生，Vault.lockForOrder 已删除调用者
// 方向参数 payWithTokenIn，见 docs/eip712-order-spec.md §2/§4），校验
// 可用余额（balanceOf − locked）后以 locker 身份调用 Vault.lockForOrder；
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
  {"inputs":[{"components":[{"internalType":"string","name":"orderId","type":"string"},{"internalType":"address","name":"userAddress","type":"address"},{"internalType":"address","name":"tokenIn","type":"address"},{"internalType":"address","name":"tokenOut","type":"address"},{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOut","type":"uint256"},{"internalType":"uint256","name":"price","type":"uint256"},{"internalType":"uint256","name":"timestamp","type":"uint256"},{"internalType":"uint256","name":"expiresAt","type":"uint256"},{"internalType":"uint256","name":"nonce","type":"uint256"},{"internalType":"uint8","name":"side","type":"uint8"}],"internalType":"struct IVaultOrder","name":"order","type":"tuple"},{"internalType":"bytes","name":"signature","type":"bytes"}],"name":"lockForOrder","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"digest","type":"bytes32"}],"name":"releaseOrderLock","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"user","type":"address"},{"internalType":"address","name":"token","type":"address"}],"name":"locked","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"user","type":"address"},{"internalType":"address","name":"token","type":"address"}],"name":"availableBalance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"name":"orderLocks","outputs":[{"internalType":"address","name":"user","type":"address"},{"internalType":"address","name":"token","type":"address"},{"internalType":"uint256","name":"remaining","type":"uint256"},{"internalType":"uint256","name":"expiresAt","type":"uint256"}],"stateMutability":"view","type":"function"},
  {"inputs":[{"internalType":"address","name":"token","type":"address"},{"internalType":"address","name":"user","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}
]`

const settlementDigestABIJSON = `[
  {"inputs":[{"components":[{"internalType":"string","name":"orderId","type":"string"},{"internalType":"address","name":"userAddress","type":"address"},{"internalType":"address","name":"tokenIn","type":"address"},{"internalType":"address","name":"tokenOut","type":"address"},{"internalType":"uint256","name":"amountIn","type":"uint256"},{"internalType":"uint256","name":"amountOut","type":"uint256"},{"internalType":"uint256","name":"price","type":"uint256"},{"internalType":"uint256","name":"timestamp","type":"uint256"},{"internalType":"uint256","name":"expiresAt","type":"uint256"},{"internalType":"uint256","name":"nonce","type":"uint256"},{"internalType":"uint8","name":"side","type":"uint8"}],"internalType":"struct IOrderDigest","name":"order","type":"tuple"}],"name":"orderDigest","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"pure","type":"function"}
]`

var (
	vaultLockABI     abi.ABI
	settlementDigABI abi.ABI
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
// 方向只从签名订单的 side 字段派生（阶段 3：side 已进 EIP-712 签名，不再
// 接受调用方自报方向）：1=sell 付 tokenIn、0=buy 付 tokenOut；非法 side
// fail-closed 报错。返回的 payWithTokenIn 同样由 side 派生（sell→true），
// 仅供调用方/测试核对，不再作为 Vault.lockForOrder 的入参（合约已删除该
// 参数、自行从 order.side 派生）。
func ObligationForOrder(so *storage.SignedOrder) (common.Address, *big.Int, bool, error) {
	if so == nil {
		return common.Address{}, nil, false, fmt.Errorf("signed order is nil")
	}
	switch so.Side {
	case 1: // sell
		amt, ok := new(big.Int).SetString(so.AmountIn, 10)
		if !ok {
			return common.Address{}, nil, false, fmt.Errorf("bad amountIn %q", so.AmountIn)
		}
		return common.HexToAddress(so.TokenIn), amt, true, nil
	case 0: // buy
		amt, ok := new(big.Int).SetString(so.AmountOut, 10)
		if !ok {
			return common.Address{}, nil, false, fmt.Errorf("bad amountOut %q", so.AmountOut)
		}
		return common.HexToAddress(so.TokenOut), amt, false, nil
	default:
		return common.Address{}, nil, false, fmt.Errorf("invalid signed order side %d", so.Side)
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
	to := common.HexToAddress(vaultAddr)
	// gas 改为链上估算×1.3（下限 21000）：第二十一轮 Vault 落锁新增外部
	// 验签/摘要调用与墓碑写入，Sepolia 实测约 725,799 gas，已超旧固定
	// 上限 600,000 并导致落锁交易 OOG 回滚（第二十二轮部署时实测定位）。
	// 估算失败时回退到 1,200,000。
	gasLimit := uint64(1_200_000)
	if est, err := client.EstimateGas(ctx, ethereum.CallMsg{From: from, To: &to, Data: data}); err == nil && est > 0 {
		gasLimit = est * 13 / 10
		if gasLimit < 21_000 {
			gasLimit = 21_000
		}
	}
	// 动态 gas 价（第二十七轮）：EIP-1559（tip + 2×当前 baseFee 为上限），
	// 替代此前单次 SuggestGasPrice 的 legacy 定价——后者在 Sepolia gas 波动
	// 时曾让落锁交易在 mempool 滞留约 3 分钟（第二十六轮 §7.3）；RPC 不支持
	// EIP-1559 时回退 legacy。
	var tx *types.Transaction
	if tipCap, feeCap, ferr := suggestDynamicFees(ctx, client); ferr == nil {
		tx = types.NewTx(&types.DynamicFeeTx{
			ChainID:   chainID,
			Nonce:     nonce,
			To:        &to,
			Value:     big.NewInt(0),
			Gas:       gasLimit,
			GasTipCap: tipCap,
			GasFeeCap: feeCap,
			Data:      data,
		})
	} else {
		gasPrice, err := client.SuggestGasPrice(ctx)
		if err != nil {
			return "", fmt.Errorf("gas price: %w", err)
		}
		tx = types.NewTx(&types.LegacyTx{
			Nonce:    nonce,
			To:       &to,
			Value:    big.NewInt(0),
			Gas:      gasLimit,
			GasPrice: gasPrice,
			Data:     data,
		})
	}
	signed, err := types.SignTx(tx, types.LatestSignerForChainID(chainID), priv)
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
	// 超时后按 hash 查回执再定论（第二十七轮）：超时≠失败——交易可能在时限
	// 边缘刚上链（返回成功）、已 revert（返回失败）、仍在排队（ErrTxPending，
	// 调用方不得按失败处理；重试前应先查既有锁定避免重复落锁）或已被丢弃
	// （ErrTxDropped，可用新 nonce 安全重发）。原上下文可能已过期，用新上下文查。
	lookupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	receipt, lerr := lookupReceipt(lookupCtx, client, signed.Hash())
	if lerr == nil {
		if receipt.Status != types.ReceiptStatusSuccessful {
			return signed.Hash().Hex(), fmt.Errorf("tx reverted: %s", signed.Hash().Hex())
		}
		return signed.Hash().Hex(), nil
	}
	return signed.Hash().Hex(), lerr
}

// suggestDynamicFees 取 EIP-1559 动态 gas 价：tip 由节点建议，fee 上限为
// 2×当前 baseFee + tip（留足波动空间）；任一步失败即返回错误，调用方回退 legacy。
func suggestDynamicFees(ctx context.Context, client *ethclient.Client) (tipCap, feeCap *big.Int, err error) {
	tipCap, err = client.SuggestGasTipCap(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("tip cap: %w", err)
	}
	header, err := client.HeaderByNumber(ctx, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("latest header: %w", err)
	}
	if header.BaseFee == nil {
		return nil, nil, fmt.Errorf("no base fee (pre-London chain)")
	}
	feeCap = new(big.Int).Add(new(big.Int).Mul(header.BaseFee, big.NewInt(2)), tipCap)
	return tipCap, feeCap, nil
}

// LockOrder 以 locker 身份为签名订单落锁：落锁前先校验可用余额覆盖义务量
// （不足直接报错、不发交易；Vault 落锁时还会再验一次）。返回订单摘要与交易哈希。
//
// 幂等（第二十七轮）：先按摘要查既有锁定——上一轮发送的落锁交易可能超时后才
// 上链（第二十六轮 §7.3），此时锁已在链上；重复落锁会被 Vault 以
// "order already locked" 拒绝，故既有锁定量覆盖义务时直接返回成功，不再发交易。
// （注意顺序：先查锁、再查可用余额——已落锁的义务量已从可用余额中扣除，
// 先查余额会把「已落锁」误判为余额不足。）
// LockOrder 的方向口径（阶段 3）：不再接受调用方 side 参数——义务与落锁
// 方向都只从签名订单 so.Side 派生，与 Vault 从 order.side 派生的口径恒一致，
// 「按错误方向为他人订单落锁」在接口层即不可能表达（见 Vault.lockForOrder）。
func LockOrder(ctx context.Context, rpcURL, vaultAddr, settlementAddr, lockerKeyHex string, so *storage.SignedOrder) (common.Hash, string, error) {
	token, amount, _, err := ObligationForOrder(so)
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
	digest, err := OrderDigest(ctx, client, settlementAddr, so)
	if err != nil {
		return common.Hash{}, "", fmt.Errorf("order digest: %w", err)
	}
	if lockUser, remaining, lerr := OrderLockRemaining(ctx, client, vaultAddr, digest); lerr == nil {
		if lockUser == common.HexToAddress(so.UserAddress) && remaining.Cmp(amount) >= 0 {
			return digest, "", nil
		}
		if lockUser != (common.Address{}) {
			return digest, "", fmt.Errorf("order %s already locked with remaining %s < obligation %s", so.OrderID, remaining, amount)
		}
	}
	user := common.HexToAddress(so.UserAddress)
	_, _, available, err := VaultBalances(ctx, client, vaultAddr, user, token)
	if err != nil {
		return common.Hash{}, "", fmt.Errorf("read vault balances: %w", err)
	}
	if available.Cmp(amount) < 0 {
		return common.Hash{}, "", fmt.Errorf("insufficient available balance: need %s, available %s (user %s token %s)", amount, available, so.UserAddress, token.Hex())
	}
	sigBytes := common.FromHex(so.Signature)
	// 阶段 3：lockForOrder(order, signature) 已无方向参数——方向由合约从
	// order.side 派生（signedOrderToABI 已贯通 Side 字段）。
	data, err := vaultLockABI.Pack("lockForOrder", signedOrderToABI(so).Order, sigBytes)
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

// EngineDecimalToWei 把撮合引擎的浮点文本数量（如 "30.000000000000000000"，
// 数值口径为最小单位）截断为整数最小单位，与 TradeToFill 的换算口径一致。
func EngineDecimalToWei(s string) (*big.Int, error) {
	return decimalToInt(s)
}

// OrderLockRemaining 读回某订单当前的锁定记录（user 为零地址表示记录不存在）。
func OrderLockRemaining(ctx context.Context, client *ethclient.Client, vaultAddr string, digest common.Hash) (common.Address, *big.Int, error) {
	to := common.HexToAddress(vaultAddr)
	data, err := vaultLockABI.Pack("orderLocks", digest)
	if err != nil {
		return common.Address{}, nil, err
	}
	out, err := client.CallContract(ctx, ethereum.CallMsg{To: &to, Data: data}, nil)
	if err != nil {
		return common.Address{}, nil, err
	}
	res, err := vaultLockABI.Unpack("orderLocks", out)
	if err != nil {
		return common.Address{}, nil, err
	}
	if len(res) != 4 {
		return common.Address{}, nil, fmt.Errorf("orderLocks: unexpected outputs %d", len(res))
	}
	user, _ := res[0].(common.Address)
	remaining, _ := res[2].(*big.Int)
	if remaining == nil {
		return common.Address{}, nil, fmt.Errorf("orderLocks: unexpected remaining type %T", res[2])
	}
	return user, remaining, nil
}

// ReleaseRemainderAfterSettlement 市价单余量锁定的精确释放（第十七轮，
// docs/market-orders.md §2.5）：Vault.releaseOrderLock 释放的是锁定记录的
// 全部剩余量，而成交部分的锁定由 Settlement 异步按笔消费——必须等链上
// 剩余量恰好降到 expectedUnused（= 未成交部分应剩的锁定量）时才能释放，
// 提前释放会把已成交未结算的部分一并放掉、令其结算 revert。
//
// 轮询等待（pollInterval）至 timeout：记录不存在（已被全部消费/释放）→
// 无需释放、返回空 tx；剩余量小于 expectedUnused → 异常（过度消费），
// 返回错误；超时 → 返回错误，调用方记日志，订单到期后可经
// releaseExpiredOrderLock 兜底释放。expectedUnused 为 0 时不应调用本函数
// （全额成交，结算将消费全部锁定）。
func ReleaseRemainderAfterSettlement(ctx context.Context, rpcURL, vaultAddr, settlementAddr, lockerKeyHex string, so *storage.SignedOrder, expectedUnused *big.Int, pollInterval, timeout time.Duration) (string, error) {
	if expectedUnused == nil || expectedUnused.Sign() <= 0 {
		return "", fmt.Errorf("expectedUnused must be positive")
	}
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return "", fmt.Errorf("dial rpc: %w", err)
	}
	defer client.Close()
	digest, err := OrderDigest(ctx, client, settlementAddr, so)
	if err != nil {
		return "", fmt.Errorf("order digest: %w", err)
	}
	deadline := time.Now().Add(timeout)
	for {
		user, remaining, err := OrderLockRemaining(ctx, client, vaultAddr, digest)
		if err != nil {
			return "", fmt.Errorf("read order lock: %w", err)
		}
		if user == (common.Address{}) {
			return "", nil // 锁定记录已不存在：无需释放
		}
		switch remaining.Cmp(expectedUnused) {
		case 0:
			return ReleaseOrderLock(ctx, rpcURL, vaultAddr, lockerKeyHex, digest)
		case -1:
			return "", fmt.Errorf("order lock over-consumed: remaining %s < expected unused %s", remaining, expectedUnused)
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("timeout waiting for settlement consumption: remaining %s, expected unused %s", remaining, expectedUnused)
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(pollInterval):
		}
	}
}
