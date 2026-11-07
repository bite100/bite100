package settlement

// 结算提交器（第二十六轮）：把撮合落库的成交真正提交上链。
//
// 根因背景：此前守护进程的成交处理只做 store.InsertTrade，settlement.SubmitTrade
// 写好且有 anvil 测试却在主程序里零调用方，epoch.go 注释里「供 relayer 批量结算」
// 的 relayer 组件从未存在——撮合与结算之间断链，成交只存在于节点本地账本。
// 本提交器就是缺失的那一环：单笔提交（批量 epoch 结算仍是未来设想，本轮不做）。
//
// 幂等设计（三层，缺一不可）：
//  1. 本地状态机（storage.trades.settle_status）：pending → submitting（原子
//     领取）→ settled/retry/failed。重复落库（gossip 回声等）走 upsert，不回滚
//     结算状态；内存队列按 trade_id 去重；工作协程串行提交——同一运营密钥的
//     链上 nonce 天然有序，且任一时刻至多一笔处于 submitting。
//  2. 提交前链上对账：读 Settlement.orderFilledIn/Out（按订单 digest 的累计
//     已结算量），与「本地 settled 成交的累计折算量 + 本笔折算量」比对。若链上
//     已覆盖本笔，说明广播后记账前进程崩溃的那一笔其实已落账——标记 settled
//     并跳过，绝不重复提交。串行纪律保证这笔账可算清：除本笔外，同订单的成交
//     要么 settled（在本地累计内）要么从未提交（不在链上累计内）。
//     前提：本节点是该 Settlement 的唯一结算提交方；若有外部提交方代结同一
//     订单，对账口径会偏移，此时第 3 层的模拟与合约累计上限仍兜底。
//  3. 提交前 eth_call 模拟：必然 revert 的结算（maker 在途撤单释放锁定、订单
//     已被填满等）不浪费真实 gas，模拟失败即确定性终态。
//
// 失败分类：
//   - 确定性失败 → failed 终态，不重试：签名订单不可得（重建失败且达尝试上限）、
//     Fill 构造失败、任一订单已过期（合约 _checkOrderValidity 必然 revert）、
//     模拟 revert、已广播但链上 revert。
//   - 瞬时失败 → retry + 指数退避：RPC 拨号/抖动、等待上链超时、无 tx hash 的
//     提交错误。达 MaxAttempts 后转 failed。
//   失败结算的归责扣费（第二十一轮 ChargeFailedSettlement）不在此自动调用，
//   与第二十一轮纪律一致：是否申报由运营策略决定，不由提交器擅自发起。

import (
	"context"
	"fmt"
	"log"
	"math/big"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// ChainChecker 是提交器对链的只读依赖（对账 + 模拟）；生产实现走 RPC，单测注入假实现。
type ChainChecker interface {
	// OrderFilled 返回某签名订单在 Settlement 中的累计已结算量（订单自身朝向）
	OrderFilled(ctx context.Context, so *storage.SignedOrder) (filledIn, filledOut *big.Int, err error)
	// SimulateSettle 以 eth_call 模拟 settleTrade，revert 时返回非 nil 错误
	SimulateSettle(ctx context.Context, from common.Address, fill Fill) error
}

const settlementFilledABIJSON = `[
  {"type":"function","name":"orderFilledIn","stateMutability":"view","inputs":[{"name":"","type":"bytes32"}],"outputs":[{"name":"","type":"uint256"}]},
  {"type":"function","name":"orderFilledOut","stateMutability":"view","inputs":[{"name":"","type":"bytes32"}],"outputs":[{"name":"","type":"uint256"}]}
]`

var settlementFilledABI abi.ABI

func init() {
	var err error
	settlementFilledABI, err = abi.JSON(strings.NewReader(settlementFilledABIJSON))
	if err != nil {
		panic(err)
	}
}

type rpcChainChecker struct {
	rpcURL         string
	settlementAddr string
}

func (c *rpcChainChecker) dial(ctx context.Context) (*ethclient.Client, error) {
	return ethclient.DialContext(ctx, c.rpcURL)
}

func (c *rpcChainChecker) OrderFilled(ctx context.Context, so *storage.SignedOrder) (*big.Int, *big.Int, error) {
	client, err := c.dial(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("dial rpc: %w", err)
	}
	defer client.Close()
	digest, err := OrderDigest(ctx, client, c.settlementAddr, so)
	if err != nil {
		return nil, nil, fmt.Errorf("order digest: %w", err)
	}
	contract := bind.NewBoundContract(common.HexToAddress(c.settlementAddr), settlementFilledABI, client, client, client)
	call := func(method string) (*big.Int, error) {
		var out *big.Int
		results := []interface{}{&out}
		if err := contract.Call(&bind.CallOpts{Context: ctx}, &results, method, digest); err != nil {
			return nil, err
		}
		if out == nil {
			out = big.NewInt(0)
		}
		return out, nil
	}
	filledIn, err := call("orderFilledIn")
	if err != nil {
		return nil, nil, err
	}
	filledOut, err := call("orderFilledOut")
	if err != nil {
		return nil, nil, err
	}
	return filledIn, filledOut, nil
}

func (c *rpcChainChecker) SimulateSettle(ctx context.Context, from common.Address, fill Fill) error {
	client, err := c.dial(ctx)
	if err != nil {
		return fmt.Errorf("dial rpc: %w", err)
	}
	defer client.Close()
	parsed, err := abi.JSON(strings.NewReader(settlementABIJSON))
	if err != nil {
		return err
	}
	data, err := parsed.Pack("settleTrade", fill)
	if err != nil {
		return err
	}
	to := common.HexToAddress(c.settlementAddr)
	_, err = client.CallContract(ctx, ethereum.CallMsg{From: from, To: &to, Data: data}, nil)
	return err
}

// SubmitterConfig 结算提交器配置。RPCURL/SettlementAddr/PrivateKeyHex 与挂单
// 锁定共用同一运营身份（locker 私钥，环境变量注入，不落配置）。
type SubmitterConfig struct {
	RPCURL         string
	SettlementAddr string
	PrivateKeyHex  string
	Store          *storage.DB
	// RebuildOrders 在成交缺少签名订单时按订单 ID 从 orders 表重建
	// （cmd/node 以 match.BuildSignedOrder 注入，与撮合时填充同源等价）；可为 nil。
	RebuildOrders func(t *storage.Trade) error
	MaxAttempts   int           // 瞬时失败最大尝试次数（含首次），默认 12
	BackoffBase   time.Duration // 退避基数，默认 10s
	BackoffMax    time.Duration // 退避上限，默认 5m
	SweepInterval time.Duration // 周期清扫间隔，默认 2m
	SubmitTimeout time.Duration // 单笔提交上下文超时，默认 6m
	// SubmitFn 实际提交动作，默认 SubmitTrade；单测注入。
	SubmitFn func(ctx context.Context, t *storage.Trade, rpcURL, settlementAddr, privateKeyHex string) (string, error)
	// Chain 链上对账/模拟，默认 RPC 实现；RPCURL 为空时为 nil（跳过前置检查）。
	Chain ChainChecker
	// Now 时钟，默认 time.Now；单测注入。
	Now func() time.Time
}

// Submitter 串行结算提交器：内存队列 + storage 状态机 + 链上对账。
type Submitter struct {
	cfg      SubmitterConfig
	operator common.Address

	queue    chan string
	mu       sync.Mutex
	inflight map[string]bool

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewSubmitter 校验配置并构造提交器（私钥在此解析一次，运营地址供日志/模拟用）。
func NewSubmitter(cfg SubmitterConfig) (*Submitter, error) {
	if cfg.Store == nil {
		return nil, fmt.Errorf("settlement submitter: store is nil")
	}
	key, err := crypto.HexToECDSA(strings.TrimPrefix(cfg.PrivateKeyHex, "0x"))
	if err != nil {
		return nil, fmt.Errorf("settlement submitter: bad private key: %w", err)
	}
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 12
	}
	if cfg.BackoffBase <= 0 {
		cfg.BackoffBase = 10 * time.Second
	}
	if cfg.BackoffMax <= 0 {
		cfg.BackoffMax = 5 * time.Minute
	}
	if cfg.SweepInterval <= 0 {
		cfg.SweepInterval = 2 * time.Minute
	}
	if cfg.SubmitTimeout <= 0 {
		cfg.SubmitTimeout = 6 * time.Minute
	}
	if cfg.SubmitFn == nil {
		cfg.SubmitFn = SubmitTrade
	}
	if cfg.Chain == nil && cfg.RPCURL != "" {
		cfg.Chain = &rpcChainChecker{rpcURL: cfg.RPCURL, settlementAddr: cfg.SettlementAddr}
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Submitter{
		cfg:      cfg,
		operator: crypto.PubkeyToAddress(key.PublicKey),
		queue:    make(chan string, 1024),
		inflight: make(map[string]bool),
	}, nil
}

// Operator 返回运营（提交方/relayer）地址
func (s *Submitter) Operator() common.Address { return s.operator }

// Start 启动工作协程与清扫：先恢复上一代进程遗留的 submitting，再做首次清扫
// （历史未结算成交在此被接管补交），随后周期清扫兜底（含经同步路径落库、
// 未经 Enqueue 的成交）。
func (s *Submitter) Start(ctx context.Context) {
	s.ctx, s.cancel = context.WithCancel(ctx)
	if n, err := s.cfg.Store.RecoverSubmittingTrades(); err != nil {
		log.Printf("[settle] 恢复遗留 submitting 失败: %v", err)
	} else if n > 0 {
		log.Printf("[settle] 恢复 %d 笔遗留 submitting 成交，提交前将逐笔链上对账", n)
	}
	s.wg.Add(2)
	go s.worker()
	go s.sweepLoop()
}

// Stop 停止提交器（等待工作协程退出）
func (s *Submitter) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
	s.wg.Wait()
}

// Enqueue 把一笔刚落库的成交送入提交队列（按 trade_id 去重，重复调用无副作用）
func (s *Submitter) Enqueue(t *storage.Trade) {
	if t == nil || t.TradeID == "" {
		return
	}
	s.enqueueID(t.TradeID)
}

func (s *Submitter) enqueueID(id string) {
	s.mu.Lock()
	if s.inflight[id] {
		s.mu.Unlock()
		return
	}
	s.inflight[id] = true
	s.mu.Unlock()
	select {
	case s.queue <- id:
	case <-s.ctx.Done():
		s.unmark(id)
	}
}

func (s *Submitter) unmark(id string) {
	s.mu.Lock()
	delete(s.inflight, id)
	s.mu.Unlock()
}

func (s *Submitter) worker() {
	defer s.wg.Done()
	for {
		select {
		case <-s.ctx.Done():
			return
		case id := <-s.queue:
			s.process(id)
			s.unmark(id)
		}
	}
}

func (s *Submitter) sweepLoop() {
	defer s.wg.Done()
	s.sweep(true)
	ticker := time.NewTicker(s.cfg.SweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.sweep(false)
		}
	}
}

// sweep 扫描本地待结算成交并入队。首次清扫打日志（运维可见历史积压），周期
// 清扫只对新发现的 pending 打日志，retry 的重入队保持安静（有自己的退避计时）。
func (s *Submitter) sweep(first bool) {
	trades, err := s.cfg.Store.ListTradesForSettlement(500)
	if err != nil {
		log.Printf("[settle] 清扫查询失败: %v", err)
		return
	}
	fresh := 0
	for _, t := range trades {
		if t.SettleStatus == storage.SettlePending {
			fresh++
		}
		s.enqueueID(t.TradeID)
	}
	if first && len(trades) > 0 {
		log.Printf("[settle] 启动清扫：发现 %d 笔待结算成交，逐笔提交", len(trades))
	} else if fresh > 0 {
		log.Printf("[settle] 清扫：发现 %d 笔新的待结算成交", fresh)
	}
}

func (s *Submitter) process(id string) {
	t, err := s.cfg.Store.GetTradeByID(id)
	if err != nil || t == nil {
		return
	}
	if t.SettleStatus == storage.SettleSettled || t.SettleStatus == storage.SettleFailed {
		return
	}
	claimed, err := s.cfg.Store.ClaimTradeForSettlement(id)
	if err != nil || !claimed {
		return
	}
	t.SettleAttempts++
	ctx, cancel := context.WithTimeout(s.ctx, s.cfg.SubmitTimeout)
	defer cancel()
	s.settleOnce(ctx, t)
}

// settleOnce 执行一笔成交的完整提交管线（对账 → 模拟 → 广播），并落终态/重试态
func (s *Submitter) settleOnce(ctx context.Context, t *storage.Trade) {
	// 1. 签名订单：优先落库 JSON，缺失时按订单 ID 重建（orders 表）
	if t.MakerOrder == nil || t.TakerOrder == nil {
		if s.cfg.RebuildOrders != nil {
			if rerr := s.cfg.RebuildOrders(t); rerr != nil {
				log.Printf("[settle] trade=%s 重建签名订单失败: %v", t.TradeID, rerr)
			}
		}
	}
	if t.MakerOrder == nil || t.TakerOrder == nil {
		s.retryOrFail(t, "signed orders unavailable for settlement")
		return
	}

	// 2. 构造 Fill（数据问题即确定性失败）
	fill, err := TradeToFill(t)
	if err != nil {
		s.markFailed(t, "", "build fill: "+err.Error())
		return
	}

	// 3. 过期预检：任一订单过期后 settleTrade 必然 revert（合约时效校验）
	now := s.cfg.Now().Unix()
	if now > t.MakerOrder.ExpiresAt || now > t.TakerOrder.ExpiresAt {
		s.markFailed(t, "", "order expired before settlement")
		return
	}

	if s.cfg.Chain != nil {
		// 4. 链上对账：已落账则跳过（进程崩溃恢复/重复触发的兜底）
		landed, cerr := s.checkLanded(ctx, t, fill)
		if cerr != nil {
			log.Printf("[settle] trade=%s 链上对账未成（继续模拟/提交）: %v", t.TradeID, cerr)
		} else if landed {
			_ = s.cfg.Store.MarkTradeSettled(t.TradeID, "", "verified on-chain via orderFilled reconciliation; original tx hash unknown")
			log.Printf("[settle] trade=%s 已在链上落账（orderFilled 对账确认），跳过重复提交", t.TradeID)
			return
		}
		// 5. 模拟：revert 即确定性失败，不花真实 gas
		if serr := s.cfg.Chain.SimulateSettle(ctx, s.operator, fill); serr != nil {
			s.markFailed(t, "", "simulation reverted: "+serr.Error())
			return
		}
	}

	// 6. 真实提交
	hash, err := s.cfg.SubmitFn(ctx, t, s.cfg.RPCURL, s.cfg.SettlementAddr, s.cfg.PrivateKeyHex)
	if err == nil {
		_ = s.cfg.Store.MarkTradeSettled(t.TradeID, hash, "")
		log.Printf("[settle] trade=%s 结算成功 tx=%s", t.TradeID, hash)
		return
	}
	if hash != "" {
		// 已广播且链上 revert：确定性失败，记录 tx 备查
		s.markFailed(t, hash, "settleTrade reverted on-chain: "+err.Error())
		return
	}
	s.retryOrFail(t, err.Error())
}

// retryOrFail 瞬时失败处理：未达上限置 retry 并按指数退避重新入队，达上限转终态
func (s *Submitter) retryOrFail(t *storage.Trade, msg string) {
	if t.SettleAttempts >= s.cfg.MaxAttempts {
		s.markFailed(t, "", fmt.Sprintf("attempts exhausted (%d): %s", t.SettleAttempts, msg))
		return
	}
	_ = s.cfg.Store.MarkTradeSettleRetry(t.TradeID, msg)
	delay := s.backoff(t.SettleAttempts)
	log.Printf("[settle] trade=%s 结算未成（第 %d 次尝试，%s 后重试）: %s", t.TradeID, t.SettleAttempts, delay, msg)
	time.AfterFunc(delay, func() { s.enqueueID(t.TradeID) })
}

func (s *Submitter) markFailed(t *storage.Trade, txHash, msg string) {
	_ = s.cfg.Store.MarkTradeSettleFailed(t.TradeID, msg, txHash)
	log.Printf("[settle] trade=%s 结算确定性失败（终态，不再重试）: %s", t.TradeID, msg)
}

func (s *Submitter) backoff(attempts int) time.Duration {
	d := s.cfg.BackoffBase
	for i := 1; i < attempts; i++ {
		d *= 2
		if d >= s.cfg.BackoffMax {
			return s.cfg.BackoffMax
		}
	}
	if d > s.cfg.BackoffMax {
		return s.cfg.BackoffMax
	}
	return d
}

// fillAddsForOrder 把一笔 Fill 折算到某个订单自身朝向的 (addIn, addOut)，
// 与合约 Settlement._accountFill 的口径逐行对应。
func fillAddsForOrder(fill Fill, so *storage.SignedOrder) (addIn, addOut *big.Int) {
	if fill.TokenIn == common.HexToAddress(so.TokenIn) {
		return fill.AmountIn, fill.AmountOut
	}
	return fill.AmountOut, fill.AmountIn
}

// settledAdds 累计某订单在本地 settled 成交中的已折算量（排除指定成交）。
// 任一 settled 成交的签名订单不可得时返回错误——此时对账口径不完整，调用方
// 应放弃本次对账结论（模拟与合约累计上限仍兜底），而不是猜测。
func (s *Submitter) settledAdds(orderID, excludeTradeID string) (*big.Int, *big.Int, error) {
	trades, err := s.cfg.Store.ListSettledTradesByOrder(orderID)
	if err != nil {
		return nil, nil, err
	}
	sumIn, sumOut := big.NewInt(0), big.NewInt(0)
	for _, st := range trades {
		if st.TradeID == excludeTradeID {
			continue
		}
		if st.MakerOrder == nil || st.TakerOrder == nil {
			if s.cfg.RebuildOrders != nil {
				_ = s.cfg.RebuildOrders(st)
			}
		}
		if st.MakerOrder == nil || st.TakerOrder == nil {
			return nil, nil, fmt.Errorf("settled trade %s missing signed orders", st.TradeID)
		}
		f, err := TradeToFill(st)
		if err != nil {
			return nil, nil, err
		}
		frame := st.MakerOrder
		if st.TakerOrderID == orderID {
			frame = st.TakerOrder
		}
		aIn, aOut := fillAddsForOrder(f, frame)
		sumIn.Add(sumIn, aIn)
		sumOut.Add(sumOut, aOut)
	}
	return sumIn, sumOut, nil
}

// checkLanded 链上对账：双方订单的链上累计已结算量是否已覆盖「本地 settled
// 累计 + 本笔」——覆盖即本笔已在链上落账（典型场景：上一代进程广播成功后、
// 回写 tx_hash 前崩溃）。
func (s *Submitter) checkLanded(ctx context.Context, t *storage.Trade, fill Fill) (bool, error) {
	mBaseIn, mBaseOut, err := s.settledAdds(t.MakerOrderID, t.TradeID)
	if err != nil {
		return false, err
	}
	tBaseIn, tBaseOut, err := s.settledAdds(t.TakerOrderID, t.TradeID)
	if err != nil {
		return false, err
	}
	mAddIn, mAddOut := fillAddsForOrder(fill, t.MakerOrder)
	tAddIn, tAddOut := fillAddsForOrder(fill, t.TakerOrder)

	fmIn, fmOut, err := s.cfg.Chain.OrderFilled(ctx, t.MakerOrder)
	if err != nil {
		return false, err
	}
	ftIn, ftOut, err := s.cfg.Chain.OrderFilled(ctx, t.TakerOrder)
	if err != nil {
		return false, err
	}
	covered := func(chainIn, chainOut, baseIn, baseOut, addIn, addOut *big.Int) bool {
		return chainIn.Cmp(new(big.Int).Add(baseIn, addIn)) >= 0 &&
			chainOut.Cmp(new(big.Int).Add(baseOut, addOut)) >= 0
	}
	return covered(fmIn, fmOut, mBaseIn, mBaseOut, mAddIn, mAddOut) &&
		covered(ftIn, ftOut, tBaseIn, tBaseOut, tAddIn, tAddOut), nil
}
