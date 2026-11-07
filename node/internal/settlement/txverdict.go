package settlement

// 交易回执定论（第二十七轮）：`bind.WaitMined` 的超时只说明「在上下文时限内
// 未见回执」，不等同于失败——交易可能已上链成功、已上链 revert、仍在排队，
// 或已被丢弃，四种状态必须分开处理。旧代码把「超时但带 hash」一律记为
// 「链上 revert」的确定性失败（submitter.go:391-394），导致已上链的结算被
// 误判终态、落锁交易超时后锁悬空（第二十六轮 §7.3 实测事故）。
//
// 本文件提供唯一事实源：SubmitTrade / ChargeFailedSettlement / sendVaultTx
// 超时后都走 lookupReceipt 按 hash 查回执再定论。回执查询须用新的短超时
// 上下文——调用方的原上下文在超时那一刻可能已经过期。

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
)

// ErrTxPending：交易已广播但链上尚无回执（仍在 mempool 排队）；定论未知，
// 调用方不得按失败处理，应重试或等回执后再定论。
var ErrTxPending = errors.New("settlement: tx broadcast but no receipt yet")

// ErrTxDropped：交易已广播但链上无回执、且 mempool 中也不见了（被丢弃或
// 被同 nonce 高价交易替代）；调用方可用新 nonce 安全重发。
var ErrTxDropped = errors.New("settlement: tx not found on-chain or in mempool (dropped)")

// lookupReceipt 按 hash 查一笔已广播交易的回执并定论：
//   - 回执已出 → 返回回执（调用方按 Status 区分成功/revert）；
//   - 无回执 → 再查 mempool：还在排队返回 ErrTxPending（瞬时），不见了返回
//     ErrTxDropped（可安全重发）；
//   - 查询本身 RPC 出错 → 返回该错误（瞬时，调用方重试）。
//
// ctx 须为新的短超时上下文（调用方的原上下文可能已过期）。
func lookupReceipt(ctx context.Context, client *ethclient.Client, hash common.Hash) (*types.Receipt, error) {
	receipt, err := client.TransactionReceipt(ctx, hash)
	if err == nil {
		return receipt, nil
	}
	if !errors.Is(err, ethereum.NotFound) {
		return nil, fmt.Errorf("settlement: receipt lookup: %w", err)
	}
	// 无回执：再看 mempool 里是否还在排队
	tx, _, perr := client.TransactionByHash(ctx, hash)
	if perr == nil && tx != nil {
		return nil, fmt.Errorf("%w: %s", ErrTxPending, hash.Hex())
	}
	if perr != nil && !errors.Is(perr, ethereum.NotFound) {
		return nil, fmt.Errorf("settlement: mempool lookup: %w", perr)
	}
	return nil, fmt.Errorf("%w: %s", ErrTxDropped, hash.Hex())
}

// waitMinedVerdict 等一笔交易上链并按回执定论：先 bind.WaitMined，超时或
// 上下文取消时按 hash 查回执再定论（原上下文可能已过期，查回执用新上下文）。
// 返回 (txHash, nil) = 已上链成功；(txHash, err) = 已上链 revert（确定性失败，
// 调用方可记终态）；(txHash, ErrTxPending) = 仍在 mempool（瞬时，调用方重试前
// 先链上对账）；(txHash, ErrTxDropped) = 已丢弃（可安全重发）；("", err) = 查
// 回执本身出错（瞬时，调用方应重试；提交器下次尝试前先链上对账）。
func waitMinedVerdict(ctx context.Context, client *ethclient.Client, tx *types.Transaction) (string, error) {
	receipt, err := bind.WaitMined(ctx, client, tx)
	if err == nil {
		if receipt.Status != types.ReceiptStatusSuccessful {
			return tx.Hash().Hex(), fmt.Errorf("settlement: tx reverted on-chain, tx=%s", tx.Hash().Hex())
		}
		return tx.Hash().Hex(), nil
	}
	// 超时/取消：按 hash 查回执再定论（原上下文可能已过期，查回执用新上下文）。
	// 滞留（ErrTxPending）与已丢弃（ErrTxDropped）时一并返回 hash：调用方凭
	// hash 区分「交易仍在排队」（重试前先链上对账）与「可安全重发」。
	lookupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	receipt, lerr := lookupReceipt(lookupCtx, client, tx.Hash())
	if lerr != nil {
		if errors.Is(lerr, ErrTxPending) || errors.Is(lerr, ErrTxDropped) {
			return tx.Hash().Hex(), lerr
		}
		return "", fmt.Errorf("settlement: wait mined: %w; receipt lookup: %v", err, lerr)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		return tx.Hash().Hex(), fmt.Errorf("settlement: tx reverted on-chain, tx=%s", tx.Hash().Hex())
	}
	return tx.Hash().Hex(), nil
}
