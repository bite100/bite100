package match

import (
	"fmt"
	"log"
	"math/big"
	"sort"
	"sync"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/metrics"
	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// PairTokens 交易对对应的链上代币（用于结算）
type PairTokens struct {
	Token0 string // base，如 TKA
	Token1 string // quote，如 TKB
}

// PeriodStats 某周期的撮合统计（贡献证明用）
type PeriodStats struct {
	Trades uint64
	Volume *big.Int // 成交量最小单位（如 amount*1e18 之和）
}

// Engine 单主撮合引擎：按交易对维护订单簿，Price-Time 优先
type Engine struct {
	mu            sync.RWMutex
	pairs         map[string]*OrderBook
	tokens        map[string]PairTokens // pair -> token0, token1
	orderIDToPair map[string]string     // orderID -> pair，用于撤单
	// 周期内撮合统计（贡献证明 40% 权重）
	currentPeriod string
	currentTrades  uint64
	currentVolume  *big.Int
	periodStats    map[string]*PeriodStats // 已结束周期缓存，供证明读取
	// 性能优化：订单验证缓存（避免重复验证）
	signatureCache map[string]bool // orderID -> 验证结果
	cacheMu        sync.RWMutex
	// 内存优化：订单簿大小限制
	maxOrdersPerPair int
}

// NewEngine 创建撮合引擎
func NewEngine(pairTokens map[string]PairTokens) *Engine {
	if pairTokens == nil {
		pairTokens = make(map[string]PairTokens)
	}
	e := &Engine{
		pairs:            make(map[string]*OrderBook),
		tokens:           pairTokens,
		orderIDToPair:    make(map[string]string),
		currentVolume:    new(big.Int),
		periodStats:      make(map[string]*PeriodStats),
		signatureCache:   make(map[string]bool, 1000), // 预分配缓存空间
		maxOrdersPerPair: 10000,                        // 默认每个交易对最多10000个订单
	}
	return e
}

// SetCurrentPeriod 设置当前统计周期；若与上次不同则保存旧周期统计并清零当前计数（由 runProofCheck 在每 tick 调用）
func (e *Engine) SetCurrentPeriod(periodStr string) {
	if periodStr == "" {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.currentPeriod == periodStr {
		return
	}
	if e.currentPeriod != "" {
		e.periodStats[e.currentPeriod] = &PeriodStats{
			Trades: e.currentTrades,
			Volume: new(big.Int).Set(e.currentVolume),
		}
	}
	e.currentPeriod = periodStr
	e.currentTrades = 0
	e.currentVolume = new(big.Int)
}

// GetPairTokens 返回交易对对应的代币地址（用于签名验证）
func (e *Engine) GetPairTokens(pair string) *PairTokens {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if tokens, ok := e.tokens[pair]; ok {
		return &tokens
	}
	return nil
}

// GetPeriodStats 返回指定周期的撮合笔数与成交量（最小单位），供贡献证明使用
func (e *Engine) GetPeriodStats(periodStr string) (trades uint64, volume *big.Int) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	vol := new(big.Int)
	if e.currentPeriod == periodStr {
		return e.currentTrades, vol.Set(e.currentVolume)
	}
	if p, ok := e.periodStats[periodStr]; ok {
		return p.Trades, vol.Set(p.Volume)
	}
	return 0, vol
}

// addMatchStats 在 Match 内调用：累加当前周期笔数与成交量（调用方需已持锁）
func (e *Engine) addMatchStats(trades []*storage.Trade) {
	if len(trades) == 0 || e.currentPeriod == "" {
		return
	}
	e.currentTrades += uint64(len(trades))
	for _, t := range trades {
		// 成交量：Amount 转为最小单位（*1e18）累加，与合约 CAP_VOLUME_MATCHED 一致
		amt := bigNew(t.Amount)
		if amt.Cmp(big.NewFloat(0)) <= 0 {
			continue
		}
		amt.Mul(amt, big.NewFloat(1e18))
		amtInt := new(big.Int)
		amt.Int(amtInt)
		e.currentVolume.Add(e.currentVolume, amtInt)
	}
}

// OrderBook 单交易对订单簿
//
// §12.2 确定性撮合：FIFO/价格优先
// - Bids：买盘，按价格降序、同价按 CreatedAt 升序（FIFO）
// - Asks：卖盘，按价格升序、同价按 CreatedAt 升序（FIFO）
// 撮合时：taker 买则吃 asks 最低价；taker 卖则吃 bids 最高价；同价先到先得
type OrderBook struct {
	Pair string
	Bids []*storage.Order // 买盘，按价格降序、时间升序
	Asks []*storage.Order // 卖盘，按价格升序、时间升序
}

// EnsurePair 确保该交易对存在
func (e *Engine) EnsurePair(pair string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.pairs[pair]; !ok {
		e.pairs[pair] = &OrderBook{Pair: pair, Bids: nil, Asks: nil}
	}
}

// GetOrderbook 返回某交易对的买卖盘副本（供 HTTP API 等只读使用）
func (e *Engine) GetOrderbook(pair string) (bids, asks []*storage.Order) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	ob, ok := e.pairs[pair]
	if !ok {
		return nil, nil
	}
	// 内存优化：预分配切片容量，减少内存分配
	bids = make([]*storage.Order, 0, len(ob.Bids))
	asks = make([]*storage.Order, 0, len(ob.Asks))
	for _, o := range ob.Bids {
		c := *o
		bids = append(bids, &c)
	}
	for _, o := range ob.Asks {
		c := *o
		asks = append(asks, &c)
	}
	return bids, asks
}

// IsSignatureValid 检查订单签名是否有效（带缓存）
func (e *Engine) IsSignatureValid(orderID string, order *storage.Order, pairTokens *PairTokens) (bool, error) {
	// 检查缓存
	e.cacheMu.RLock()
	if cached, ok := e.signatureCache[orderID]; ok {
		e.cacheMu.RUnlock()
		metrics.RecordSignatureCacheHit()
		return cached, nil
	}
	e.cacheMu.RUnlock()
	metrics.RecordSignatureCacheMiss()
	
	// 验证签名
	valid, err := VerifyOrderSignature(order, pairTokens)
	if err != nil {
		return false, err
	}
	
	// 更新缓存（限制缓存大小）
	e.cacheMu.Lock()
	if len(e.signatureCache) < 10000 {
		e.signatureCache[orderID] = valid
	}
	e.cacheMu.Unlock()
	
	return valid, nil
}

// ClearSignatureCache 清除签名缓存（定期清理过期缓存）
func (e *Engine) ClearSignatureCache() {
	e.cacheMu.Lock()
	defer e.cacheMu.Unlock()
	// 保留最近1000个缓存项
	if len(e.signatureCache) > 1000 {
		// 简单策略：清空缓存（实际可以保留最近使用的）
		e.signatureCache = make(map[string]bool, 1000)
	}
}

// AddOrder 将订单加入订单簿（未撮合部分）；同 orderID 先移除再插入；返回是否插入成功；已过期订单不加入（Replay/过期防护）
func (e *Engine) AddOrder(o *storage.Order) bool {
	if o.OrderID == "" || o.Pair == "" || o.Side == "" || o.Price == "" || o.Amount == "" {
		return false
	}
	if storage.OrderExpired(o) {
		return false
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	// 同 orderID 先移除（避免重复挂单）
	if ob, ok := e.pairs[o.Pair]; ok {
		removeOrderFromBook(ob, o.OrderID)
	}
	ob, ok := e.pairs[o.Pair]
	if !ok {
		ob = &OrderBook{Pair: o.Pair}
		e.pairs[o.Pair] = ob
	}
	filled := bigNew(o.Filled)
	amount := bigNew(o.Amount)
	left := new(big.Float).Sub(amount, filled)
	if left.Cmp(big.NewFloat(0)) <= 0 {
		return false
	}
	e.orderIDToPair[o.OrderID] = o.Pair
	o2 := *o
	o2.Filled = "0"
	o2.Amount = left.Text('f', 18)
	// 内存管理优化：限制订单簿大小
	if o.Side == "buy" {
		if len(ob.Bids) >= e.maxOrdersPerPair {
			// 移除最旧的订单（价格最低或时间最晚）
			if len(ob.Bids) > 0 {
				ob.Bids = ob.Bids[:len(ob.Bids)-1]
			}
		}
		ob.Bids = append(ob.Bids, &o2)
		// 算法优化：使用更高效的插入排序（对于已排序列表，插入排序比完整排序更快）
		e.insertOrderSorted(ob.Bids, true)
	} else {
		if len(ob.Asks) >= e.maxOrdersPerPair {
			if len(ob.Asks) > 0 {
				ob.Asks = ob.Asks[:len(ob.Asks)-1]
			}
		}
		ob.Asks = append(ob.Asks, &o2)
		e.insertOrderSorted(ob.Asks, false)
	}
	return true
}

// insertOrderSorted 将订单插入到已排序的列表中（优化：O(n)插入而非O(n log n)排序）
func (e *Engine) insertOrderSorted(orders []*storage.Order, isBids bool) {
	if len(orders) <= 1 {
		return
	}
	// 找到插入位置
	newOrder := orders[len(orders)-1]
	newPrice := bigNew(newOrder.Price)
	insertIdx := len(orders) - 1
	
	for i := len(orders) - 2; i >= 0; i-- {
		price := bigNew(orders[i].Price)
		var shouldSwap bool
		if isBids {
			shouldSwap = newPrice.Cmp(price) > 0 || (newPrice.Cmp(price) == 0 && newOrder.CreatedAt < orders[i].CreatedAt)
		} else {
			shouldSwap = newPrice.Cmp(price) < 0 || (newPrice.Cmp(price) == 0 && newOrder.CreatedAt < orders[i].CreatedAt)
		}
		if shouldSwap {
			orders[i+1], orders[i] = orders[i], orders[i+1]
			insertIdx = i
		} else {
			break
		}
	}
}
}

// ReplaceOrderbook 用给定买卖盘替换某交易对的订单簿（用于 1.2 订单簿同步）；跳过已过期订单
func (e *Engine) ReplaceOrderbook(pair string, bids, asks []*storage.Order) {
	if pair == "" {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	// 清除该 pair 下原有订单的 orderIDToPair
	if ob, ok := e.pairs[pair]; ok {
		for _, o := range ob.Bids {
			delete(e.orderIDToPair, o.OrderID)
		}
		for _, o := range ob.Asks {
			delete(e.orderIDToPair, o.OrderID)
		}
	}
	ob := &OrderBook{Pair: pair}
	for _, o := range bids {
		if o == nil || o.OrderID == "" || storage.OrderExpired(o) {
			continue
		}
		amount := bigNew(o.Amount)
		filled := bigNew(o.Filled)
		left := new(big.Float).Sub(amount, filled)
		if left.Cmp(big.NewFloat(0)) <= 0 {
			continue
		}
		o2 := *o
		o2.Filled = "0"
		o2.Amount = left.Text('f', 18)
		ob.Bids = append(ob.Bids, &o2)
		e.orderIDToPair[o.OrderID] = pair
	}
	for _, o := range asks {
		if o == nil || o.OrderID == "" || storage.OrderExpired(o) {
			continue
		}
		amount := bigNew(o.Amount)
		filled := bigNew(o.Filled)
		left := new(big.Float).Sub(amount, filled)
		if left.Cmp(big.NewFloat(0)) <= 0 {
			continue
		}
		o2 := *o
		o2.Filled = "0"
		o2.Amount = left.Text('f', 18)
		ob.Asks = append(ob.Asks, &o2)
		e.orderIDToPair[o.OrderID] = pair
	}
	// 算法优化：使用稳定的排序算法，减少比较次数
	e.sortOrdersOptimized(ob.Bids, true)
	e.sortOrdersOptimized(ob.Asks, false)
	e.pairs[pair] = ob
}

// sortOrdersOptimized 优化的排序函数（使用稳定的排序算法）
func (e *Engine) sortOrdersOptimized(orders []*storage.Order, isBids bool) {
	if len(orders) <= 1 {
		return
	}
	// 使用稳定的排序，保持相同价格的订单按时间顺序
	sort.SliceStable(orders, func(i, j int) bool {
		pi, pj := bigNew(orders[i].Price), bigNew(orders[j].Price)
		cmp := pi.Cmp(pj)
		if cmp != 0 {
			if isBids {
				return cmp > 0 // 买盘：价格降序
			}
			return cmp < 0 // 卖盘：价格升序
		}
		return orders[i].CreatedAt < orders[j].CreatedAt // 同价按时间升序
	})
}

// RemoveOrder 从订单簿移除订单（撤单）；若 pair 为空则按 orderID 查找
func (e *Engine) RemoveOrder(pair, orderID string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if pair == "" {
		pair = e.orderIDToPair[orderID]
		delete(e.orderIDToPair, orderID)
	}
	if pair == "" {
		for p, ob := range e.pairs {
			if removeOrderFromBook(ob, orderID) {
				return true
			}
			_ = p
		}
		return false
	}
	ob, ok := e.pairs[pair]
	if !ok {
		return false
	}
	ok = removeOrderFromBook(ob, orderID)
	if ok {
		delete(e.orderIDToPair, orderID)
	}
	return ok
}

func removeOrderFromBook(ob *OrderBook, orderID string) bool {
	// 内存优化：使用更高效的删除方式（避免不必要的内存分配）
	remove := func(orders []*storage.Order) []*storage.Order {
		for i, o := range orders {
			if o.OrderID == orderID {
				// 使用切片技巧快速删除
				return append(orders[:i], orders[i+1:]...)
			}
		}
		return orders
	}
	before := len(ob.Bids) + len(ob.Asks)
	ob.Bids = remove(ob.Bids)
	ob.Asks = remove(ob.Asks)
	return len(ob.Bids)+len(ob.Asks) < before
}

// Match 用 taker 订单与对手盘撮合，返回成交列表并更新订单簿内订单的 filled/status
func (e *Engine) Match(taker *storage.Order) (trades []*storage.Trade) {
	t0 := time.Now()
	defer func() { metrics.RecordMatch(len(trades), time.Since(t0)) }()
	if taker.OrderID == "" || taker.Pair == "" || taker.Side == "" || taker.Price == "" || taker.Amount == "" {
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	ob, ok := e.pairs[taker.Pair]
	if !ok {
		ob = &OrderBook{Pair: taker.Pair}
		e.pairs[taker.Pair] = ob
	}
	tokens := e.tokens[taker.Pair]
	takerLeft := bigNew(taker.Amount)
	takerFilled := bigNew(taker.Filled)
	takerLeft.Sub(takerLeft, takerFilled)
	if takerLeft.Cmp(big.NewFloat(0)) <= 0 {
		return nil
	}
	now := time.Now().Unix()
	// 确定性 TradeID：相同输入产生相同 ID，便于多节点共识时结果一致（清单 1.2 撮合结果不一致）
	tradeSeq := 0
	genTradeID := func(makerOrderID string) string {
		tradeSeq++
		return fmt.Sprintf("%s-%s-%d", taker.OrderID, makerOrderID, tradeSeq)
	}

	if taker.Side == "buy" {
		// taker 买，吃卖盘（asks 最低价优先）
		for len(ob.Asks) > 0 && takerLeft.Cmp(big.NewFloat(0)) > 0 {
			maker := ob.Asks[0]
			makerPrice := bigNew(maker.Price)
			takerPrice := bigNew(taker.Price)
			if takerPrice.Cmp(makerPrice) < 0 {
				break
			}
			makerLeft := bigNew(maker.Amount)
			makerFilled := bigNew(maker.Filled)
			makerLeft.Sub(makerLeft, makerFilled)
			if makerLeft.Cmp(big.NewFloat(0)) <= 0 {
				ob.Asks = ob.Asks[1:]
				continue
			}
			// 成交量 = min(takerLeft, makerLeft)
			qty := new(big.Float).Set(takerLeft)
			if makerLeft.Cmp(qty) < 0 {
				qty.Set(makerLeft)
			}
			price := makerPrice
			amountIn := qty
			amountOut := new(big.Float).Mul(qty, price)
			t := &storage.Trade{
				TradeID:      genTradeID(maker.OrderID),
				Pair:         taker.Pair,
				MakerOrderID: maker.OrderID,
				TakerOrderID: taker.OrderID,
				Maker:        maker.Trader,
				Taker:        taker.Trader,
				TokenIn:      tokens.Token0,
				TokenOut:     tokens.Token1,
				AmountIn:     amountIn.Text('f', 18),
				AmountOut:    amountOut.Text('f', 18),
				Price:        price.Text('f', 18),
				Amount:       qty.Text('f', 18),
				Timestamp:    now,
			}
			trades = append(trades, t)
			takerLeft.Sub(takerLeft, qty)
			takerFilled.Add(takerFilled, qty)
			makerFilled.Add(makerFilled, qty)
			maker.Filled = makerFilled.Text('f', 18)
			if makerLeft.Cmp(qty) == 0 {
				maker.Status = "filled"
				ob.Asks = ob.Asks[1:]
			} else {
				maker.Status = "partial"
			}
		}
		taker.Filled = takerFilled.Text('f', 18)
		if takerLeft.Cmp(big.NewFloat(0)) <= 0 {
			taker.Status = "filled"
		} else {
			taker.Status = "partial"
		}
	} else {
		// taker 卖，吃买盘（bids 最高价优先）；maker 买 Token0 用 Token1，故 tokenIn=Token1, tokenOut=Token0
		for len(ob.Bids) > 0 && takerLeft.Cmp(big.NewFloat(0)) > 0 {
			maker := ob.Bids[0]
			makerPrice := bigNew(maker.Price)
			takerPrice := bigNew(taker.Price)
			if takerPrice.Cmp(makerPrice) > 0 {
				break
			}
			makerLeft := bigNew(maker.Amount)
			makerFilled := bigNew(maker.Filled)
			makerLeft.Sub(makerLeft, makerFilled)
			if makerLeft.Cmp(big.NewFloat(0)) <= 0 {
				ob.Bids = ob.Bids[1:]
				continue
			}
			qty := new(big.Float).Set(takerLeft)
			if makerLeft.Cmp(qty) < 0 {
				qty.Set(makerLeft)
			}
			price := makerPrice
			amountIn := qty
			amountOut := new(big.Float).Mul(qty, price)
			t := &storage.Trade{
				TradeID:      genTradeID(maker.OrderID),
				Pair:         taker.Pair,
				MakerOrderID: maker.OrderID,
				TakerOrderID: taker.OrderID,
				Maker:        maker.Trader,
				Taker:        taker.Trader,
				TokenIn:      tokens.Token1,
				TokenOut:     tokens.Token0,
				AmountIn:     amountOut.Text('f', 18),
				AmountOut:    amountIn.Text('f', 18),
				Price:        price.Text('f', 18),
				Amount:       qty.Text('f', 18),
				Timestamp:    now,
			}
			trades = append(trades, t)
			takerLeft.Sub(takerLeft, qty)
			takerFilled.Add(takerFilled, qty)
			makerFilled.Add(makerFilled, qty)
			maker.Filled = makerFilled.Text('f', 18)
			if makerLeft.Cmp(qty) == 0 {
				maker.Status = "filled"
				ob.Bids = ob.Bids[1:]
			} else {
				maker.Status = "partial"
			}
		}
		taker.Filled = takerFilled.Text('f', 18)
		if takerLeft.Cmp(big.NewFloat(0)) <= 0 {
			taker.Status = "filled"
		} else {
			taker.Status = "partial"
		}
	}

	// 清理已完全成交的档位
	ob.Bids = trimFilled(ob.Bids)
	ob.Asks = trimFilled(ob.Asks)

	if len(trades) > 0 {
		log.Printf("[match] pair=%s taker=%s 成交 %d 笔", taker.Pair, taker.OrderID, len(trades))
		e.addMatchStats(trades)
	}
	
	// 性能监控：记录订单簿大小
	if ob, ok := e.pairs[taker.Pair]; ok {
		metrics.RecordOrderbookSize(taker.Pair, len(ob.Bids), len(ob.Asks))
	}
	metrics.RecordOrderProcessed()
	
	return trades
}

// MatchBatch §12.2 Epoch 内批量撮合：对多笔 taker 按 pair+CreatedAt+OrderID 确定性排序后依次撮合
// 返回所有成交，供 relayer 按 Epoch 分组后调用 settleTradesBatch
func (e *Engine) MatchBatch(takers []*storage.Order) (trades []*storage.Trade) {
	if len(takers) == 0 {
		return nil
	}
	// 确定性排序：pair 升序、CreatedAt 升序、OrderID 升序
	sorted := make([]*storage.Order, len(takers))
	copy(sorted, takers)
	sort.Slice(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		if a.Pair != b.Pair {
			return a.Pair < b.Pair
		}
		if a.CreatedAt != b.CreatedAt {
			return a.CreatedAt < b.CreatedAt
		}
		return a.OrderID < b.OrderID
	})
	for _, t := range sorted {
		trades = append(trades, e.Match(t)...)
	}
	return trades
}

func trimFilled(orders []*storage.Order) []*storage.Order {
	out := orders[:0]
	for _, o := range orders {
		if o.Status != "filled" {
			out = append(out, o)
		}
	}
	return out
}

func bigNew(s string) *big.Float {
	if s == "" {
		return big.NewFloat(0)
	}
	f, _ := new(big.Float).SetString(s)
	if f == nil {
		return big.NewFloat(0)
	}
	return f
}
