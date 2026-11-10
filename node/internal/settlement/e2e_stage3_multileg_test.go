package settlement

// 阶段 3 块 D2 / 第 43 轮块 A：多腿双路对账 E2E —— 节点路径驱动
// （本地 anvil，绝不连外网）。
//
// 与前端路径驱动（frontend/scripts/stage3-e2e/driver-multileg.ts）使用
// 完全相同的部署顺序、账户（anvil #0/#1/#2）、订单字段与价格，跑四个
// 共享场景，结果 JSON 由 compare-multileg.mjs 逐腿对账：
//
//	S1 市价买 120 吃三档（40@2.0 / 50@2.1 / 60@2.2 的前 30）——多腿主场景
//	S2 市价买 100 只剩 30 可吃 → 成交 30、余量 70 按市价语义取消（不入簿）
//	S3 陈旧腿：m5 先被另一通道（owner 的 oc 单）全量成交，主撮合仍按
//	   旧簿产出 m4+m5 两腿；节点路径逐笔提交时 m5 腿必然失败（累计已满），
//	   与前端路径的预检剔腿收敛到同一成交集
//	S5 腿数触顶：55 档 × 1 TKA，市价买 60 → 引擎产 55 腿，按批上限 50
//	   只提交前 50 腿（与前端 capLegs 同口径），余 5 档不成交
//
// 仅当 BIT100_ANVIL_RPC 存在时运行；结果 JSON 写 BIT100_MULTILEG_OUT。
// anvil 需以 --gas-price 1000000000 启动（与 D1 同口径）。

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"

	"github.com/P2P-P2P/p2p/node/internal/match"
	"github.com/P2P-P2P/p2p/node/internal/storage"
)

type mlLeg struct {
	MakerOrderID string `json:"makerOrderId"`
	TakerOrderID string `json:"takerOrderId"`
	QtyToken0    string `json:"qtyToken0"`
	PriceWei     string `json:"priceWei"`
	QuoteAmount  string `json:"quoteAmount"`
}

type mlGasEvent struct {
	GasUsed        string `json:"gasUsed"`
	Reason         string `json:"reason"`
	MakerDeduct    string `json:"makerDeduct"`
	MakerShortfall string `json:"makerShortfall"`
	TakerDeduct    string `json:"takerDeduct"`
	TakerShortfall string `json:"takerShortfall"`
}

type mlScenario struct {
	Name         string       `json:"name"`
	Legs         []mlLeg      `json:"legs"`
	SettledLegs  []mlLeg      `json:"settledLegs"`
	StaleLegs    []mlLeg      `json:"staleLegs"`
	Remainder    string       `json:"remainderToken0"`
	GasEvents    []mlGasEvent `json:"gasEvents"`
	SettleGasSum string       `json:"settleGasUsedTotal"`
}

type mlResult struct {
	Path           string                       `json:"path"`
	Addresses      map[string]string            `json:"addresses"`
	Orders         map[string]string            `json:"orders"`
	Scenarios      []mlScenario                 `json:"scenarios"`
	Filled         map[string]map[string]string `json:"filled"`
	Nonces         map[string]string            `json:"nonces"`
	Vault          map[string]string            `json:"vault"`
	FeeDistributor map[string]string            `json:"feeDistributor"`
	Developer      map[string]string            `json:"developer"`
	Deposits       map[string]string            `json:"deposits"`
}

const (
	mlBaseTs = int64(1700000000)
	mlExpTs  = int64(2000000000)
)

func TestAnvilStage3MultiLegNodePath(t *testing.T) {
	rpc := os.Getenv("BIT100_ANVIL_RPC")
	if rpc == "" {
		t.Skip("BIT100_ANVIL_RPC not set; skipping anvil e2e")
	}
	ctx := context.Background()
	client, err := ethclient.Dial(rpc)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	chainID, err := client.ChainID(ctx)
	if err != nil {
		t.Fatalf("chain id: %v", err)
	}
	t.Logf("multileg chain id: %s", chainID)

	ownerKey, _ := crypto.HexToECDSA(anvilOwnerKeyHex)
	makerKey, _ := crypto.HexToECDSA(anvilMakerKeyHex)
	takerKey, _ := crypto.HexToECDSA(anvilTakerKeyHex)
	owner := crypto.PubkeyToAddress(ownerKey.PublicKey)
	maker := crypto.PubkeyToAddress(makerKey.PublicKey)
	taker := crypto.PubkeyToAddress(takerKey.PublicKey)
	dev := common.HexToAddress(anvilDevAddr)

	e18 := new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)
	tok := func(n int64) *big.Int { return new(big.Int).Mul(big.NewInt(n), e18) }
	supply := new(big.Int).Mul(big.NewInt(1000000), e18)

	// ---- 部署（顺序与前端路径驱动逐字一致 → 地址一致） ----
	tokenAArt := loadArtifact(t, "MockERC20")
	tokenAAddr, tokenA := deploy(t, client, ownerKey, tokenAArt, "TokenA", "TKA", supply)
	tokenBAddr, tokenB := deploy(t, client, ownerKey, tokenAArt, "TokenB", "TKB", supply)
	vaultArt := loadArtifact(t, "Vault")
	vaultAddr, vault := deploy(t, client, ownerKey, vaultArt)
	feeDistArt := loadArtifact(t, "FeeDistributor")
	feeDistAddr, feeDist := deploy(t, client, ownerKey, feeDistArt)
	settlementArt := loadArtifact(t, "Settlement")
	settlementAddr, settlement := deploy(t, client, ownerKey, settlementArt, vaultAddr, feeDistAddr)
	chainConfigArt := loadArtifact(t, "ChainConfig")
	chainConfigAddr, chainConfig := deploy(t, client, ownerKey, chainConfigArt)

	do := func(contract *bind.BoundContract, key *ecdsa.PrivateKey, method string, args ...interface{}) *types.Transaction {
		tx, err := contract.Transact(transactor(t, client, key), method, args...)
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		receipt, err := bind.WaitMined(ctx, client, tx)
		if err != nil {
			t.Fatalf("%s wait: %v", method, err)
		}
		if receipt.Status != types.ReceiptStatusSuccessful {
			t.Fatalf("%s reverted, tx=%s", method, tx.Hash().Hex())
		}
		return tx
	}
	call := func(contract *bind.BoundContract, method string, args ...interface{}) *big.Int {
		var out []interface{}
		if err := contract.Call(&bind.CallOpts{Context: ctx}, &out, method, args...); err != nil {
			t.Fatalf("call %s: %v", method, err)
		}
		return out[0].(*big.Int)
	}

	do(vault, ownerKey, "setSettlement", settlementAddr)
	do(settlement, ownerKey, "setChainConfig", chainConfigAddr)
	do(chainConfig, ownerKey, "setQuotePricing", tokenBAddr, tok(2000))
	do(feeDist, ownerKey, "setDeveloperAddress", dev)

	// ---- 资金与 Vault 存款 ----
	maxUint := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	do(tokenA, ownerKey, "transfer", maker, tok(1000))
	do(tokenB, ownerKey, "transfer", taker, tok(1000))
	do(tokenA, makerKey, "approve", vaultAddr, maxUint)
	do(vault, makerKey, "deposit", tokenAAddr, tok(400))
	do(tokenB, takerKey, "approve", vaultAddr, maxUint)
	do(vault, takerKey, "deposit", tokenBAddr, tok(1000))
	do(tokenB, ownerKey, "approve", vaultAddr, maxUint)
	do(vault, ownerKey, "deposit", tokenBAddr, tok(100))

	// ---- 订单构造（字段与前端驱动逐字一致） ----
	match.SetDomain(chainID, settlementAddr)
	pair := "TKA/TKB"
	pairTokens := match.PairTokens{Token0: tokenAAddr.Hex(), Token1: tokenBAddr.Hex()}
	type ordSpec struct {
		id     string
		trader common.Address
		key    *ecdsa.PrivateKey
		side   string
		price  string // wei
		amount string // wei（Token0）
		nonce  int64
		ts     int64
		market bool
	}
	specs := map[string]*storage.Order{}
	signSpec := func(s ordSpec) *storage.Order {
		o := &storage.Order{
			OrderID: s.id, Trader: s.trader.Hex(), Pair: pair, Side: s.side,
			Price: s.price, Amount: s.amount, Filled: "0", Status: "open",
			Nonce: s.nonce, CreatedAt: s.ts, ExpiresAt: mlExpTs,
		}
		if s.market {
			o.ExecType = storage.ExecTypeMarket
		}
		sig, err := match.SignOrder(s.key, match.BuildSignedOrder(o, &pairTokens))
		if err != nil {
			t.Fatal(err)
		}
		o.Signature = sig
		specs[s.id] = o
		return o
	}
	p2 := "2000000000000000000"
	p21 := "2100000000000000000"
	p22 := "2200000000000000000"
	p25 := "2500000000000000000"
	// S1 三档卖盘 + 市价买
	signSpec(ordSpec{"ml-m1", maker, makerKey, "sell", p2, tok(40).String(), 0, mlBaseTs, false})
	signSpec(ordSpec{"ml-m2", maker, makerKey, "sell", p21, tok(50).String(), 1, mlBaseTs + 1, false})
	signSpec(ordSpec{"ml-m3", maker, makerKey, "sell", p22, tok(60).String(), 2, mlBaseTs + 2, false})
	signSpec(ordSpec{"ml-t1", taker, takerKey, "buy", p25, tok(120).String(), 0, mlBaseTs + 3, true})
	// S2 市价买（余量取消）
	signSpec(ordSpec{"ml-t2", taker, takerKey, "buy", p25, tok(100).String(), 1, mlBaseTs + 4, true})
	// S3 陈旧腿：m5（nonce 3）先被 oc 通道成交，m4（nonce 4）正常
	signSpec(ordSpec{"ml-m4", maker, makerKey, "sell", p2, tok(10).String(), 4, mlBaseTs + 5, false})
	signSpec(ordSpec{"ml-m5", maker, makerKey, "sell", p21, tok(10).String(), 3, mlBaseTs + 6, false})
	signSpec(ordSpec{"ml-oc", owner, ownerKey, "buy", p21, tok(10).String(), 0, mlBaseTs + 8, false})
	signSpec(ordSpec{"ml-t3", taker, takerKey, "buy", p25, tok(20).String(), 2, mlBaseTs + 7, true})
	// S5 触顶：55 档 × 1 TKA @2.0（nonce 5..59，ts 递增）+ 市价买 60
	for i := 0; i < 55; i++ {
		signSpec(ordSpec{fmt.Sprintf("ml-c%02d", i), maker, makerKey, "sell", p2, tok(1).String(), int64(5 + i), mlBaseTs + 100 + int64(i), false})
	}
	signSpec(ordSpec{"ml-t4", taker, takerKey, "buy", p25, tok(60).String(), 3, mlBaseTs + 200, true})

	eng := match.NewEngine(map[string]match.PairTokens{pair: pairTokens})
	locked := map[string]bool{}
	lock := func(id string) {
		if locked[id] {
			return
		}
		locked[id] = true
		o := specs[id]
		if _, _, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), anvilOwnerKeyHex, match.BuildSignedOrder(o, &pairTokens)); err != nil {
			t.Fatalf("LockOrder(%s): %v", id, err)
		}
	}
	gasEvtID := settlementArt.ABI.Events["GasCostShared"].ID
	submit := func(tr *storage.Trade, sc *mlScenario) error {
		txHash, err := SubmitTrade(ctx, tr, rpc, settlementAddr.Hex(), anvilOwnerKeyHex)
		if err != nil {
			return err
		}
		receipt, err := client.TransactionReceipt(ctx, common.HexToHash(txHash))
		if err != nil {
			t.Fatal(err)
		}
		sc.SettleGasSum = new(big.Int).Add(bigIntOrZero(sc.SettleGasSum), big.NewInt(int64(receipt.GasUsed))).String()
		for _, log := range receipt.Logs {
			if len(log.Topics) == 0 || log.Topics[0] != gasEvtID {
				continue
			}
			vals, err := settlementArt.ABI.Events["GasCostShared"].Inputs.Unpack(log.Data)
			if err != nil {
				t.Fatalf("unpack GasCostShared: %v", err)
			}
			sc.GasEvents = append(sc.GasEvents, mlGasEvent{
				GasUsed:        vals[0].(*big.Int).String(),
				Reason:         big.NewInt(int64(vals[2].(uint8))).String(),
				MakerDeduct:    vals[4].(*big.Int).String(),
				MakerShortfall: vals[5].(*big.Int).String(),
				TakerDeduct:    vals[7].(*big.Int).String(),
				TakerShortfall: vals[8].(*big.Int).String(),
			})
		}
		return nil
	}
	legOf := func(tr *storage.Trade) mlLeg {
		fill, err := TradeToFill(tr)
		if err != nil {
			t.Fatal(err)
		}
		priceWei, err := decimalToInt(tr.Price)
		if err != nil {
			t.Fatal(err)
		}
		return mlLeg{
			MakerOrderID: tr.MakerOrderID, TakerOrderID: tr.TakerOrderID,
			QtyToken0: fill.AmountIn.String(), PriceWei: priceWei.String(), QuoteAmount: fill.AmountOut.String(),
		}
	}
	runMarket := func(sc *mlScenario, takerID string, submitFirst int) {
		exec := eng.ExecuteMarketOrder(specs[takerID])
		for _, tr := range exec.Trades {
			sc.Legs = append(sc.Legs, legOf(tr))
		}
		rem, err := decimalToInt(exec.Remainder)
		if err != nil {
			t.Fatal(err)
		}
		sc.Remainder = rem.String()
		n := len(exec.Trades)
		if submitFirst >= 0 && submitFirst < n {
			n = submitFirst
		}
		for i, tr := range exec.Trades {
			if i >= n {
				break
			}
			lock(tr.MakerOrderID)
			lock(takerID)
			if err := submit(tr, sc); err != nil {
				sc.StaleLegs = append(sc.StaleLegs, legOf(tr))
				continue
			}
			sc.SettledLegs = append(sc.SettledLegs, legOf(tr))
		}
	}

	res := mlResult{
		Path:      "node",
		Addresses: map[string]string{"tokenA": tokenAAddr.Hex(), "tokenB": tokenBAddr.Hex(), "vault": vaultAddr.Hex(), "feeDistributor": feeDistAddr.Hex(), "settlement": settlementAddr.Hex()},
		Orders:    map[string]string{},
		Deposits:  map[string]string{"makerA": tok(400).String(), "takerB": tok(1000).String(), "ownerB": tok(100).String()},
	}

	// ---- S1 多档市价买 ----
	for _, id := range []string{"ml-m1", "ml-m2", "ml-m3"} {
		if !eng.AddOrder(specs[id]) {
			t.Fatalf("AddOrder(%s) rejected", id)
		}
	}
	s1 := mlScenario{Name: "S1-multilevel", Remainder: "0", SettleGasSum: "0"}
	runMarket(&s1, "ml-t1", -1)
	if len(s1.SettledLegs) != 3 {
		t.Fatalf("S1: expected 3 settled legs, got %d (stale %d)", len(s1.SettledLegs), len(s1.StaleLegs))
	}
	res.Scenarios = append(res.Scenarios, s1)

	// ---- S2 部分成交 + 余量取消 ----
	s2 := mlScenario{Name: "S2-partial-remainder", Remainder: "0", SettleGasSum: "0"}
	runMarket(&s2, "ml-t2", -1)
	if len(s2.SettledLegs) != 1 {
		t.Fatalf("S2: expected 1 settled leg, got %d", len(s2.SettledLegs))
	}
	if bids, _ := eng.GetOrderbook(pair); len(bids) != 0 {
		t.Fatalf("S2: market taker must not rest in book, got %d bids", len(bids))
	}
	res.Scenarios = append(res.Scenarios, s2)

	// ---- S3 陈旧腿（m5 先被 oc 通道全量成交） ----
	engPre := match.NewEngine(map[string]match.PairTokens{pair: pairTokens})
	if !engPre.AddOrder(specs["ml-m5"]) {
		t.Fatal("AddOrder(ml-m5) rejected (pre-fill engine)")
	}
	preTrades := engPre.Match(specs["ml-oc"])
	if len(preTrades) != 1 {
		t.Fatalf("S3 pre-fill: expected 1 trade, got %d", len(preTrades))
	}
	lock("ml-m5")
	lock("ml-oc")
	s3 := mlScenario{Name: "S3-stale-leg", Remainder: "0", SettleGasSum: "0"}
	if err := submit(preTrades[0], &s3); err != nil {
		t.Fatalf("S3 pre-fill SubmitTrade: %v", err)
	}
	s3.SettledLegs = append(s3.SettledLegs, legOf(preTrades[0]))
	// 主簿仍持旧状态（m5 未成交）→ 主撮合产出两腿，第二腿提交必失败
	if !eng.AddOrder(specs["ml-m4"]) || !eng.AddOrder(specs["ml-m5"]) {
		t.Fatal("AddOrder(ml-m4/ml-m5) rejected")
	}
	runMarket(&s3, "ml-t3", -1)
	if len(s3.StaleLegs) != 1 || s3.StaleLegs[0].MakerOrderID != "ml-m5" {
		t.Fatalf("S3: expected exactly the ml-m5 leg to go stale, got %+v", s3.StaleLegs)
	}
	res.Scenarios = append(res.Scenarios, s3)

	// ---- S5 腿数触顶（55 腿，只提交前 50） ----
	for i := 0; i < 55; i++ {
		id := fmt.Sprintf("ml-c%02d", i)
		if !eng.AddOrder(specs[id]) {
			t.Fatalf("AddOrder(%s) rejected", id)
		}
	}
	s5 := mlScenario{Name: "S5-leg-cap", Remainder: "0", SettleGasSum: "0"}
	runMarket(&s5, "ml-t4", 50)
	if len(s5.Legs) != 55 || len(s5.SettledLegs) != 50 {
		t.Fatalf("S5: expected 55 legs / 50 settled, got %d / %d", len(s5.Legs), len(s5.SettledLegs))
	}
	res.Scenarios = append(res.Scenarios, s5)

	// ---- 结果采集 ----
	for id, o := range specs {
		d, err := match.OrderDigest(match.BuildSignedOrder(o, &pairTokens))
		if err != nil {
			t.Fatal(err)
		}
		res.Orders[id] = d.Hex()
	}
	res.Filled = map[string]map[string]string{}
	for id := range specs {
		d := common.HexToHash(res.Orders[id])
		res.Filled[id] = map[string]string{
			"in":  call(settlement, "orderFilledIn", d).String(),
			"out": call(settlement, "orderFilledOut", d).String(),
		}
	}
	// 第 62 轮：getCurrentNonce 已删除；Nonces 改报 nonceBitmap 的
	// word 0（已消耗 nonce 集合的位图，compare 按位图口径对账）
	res.Nonces = map[string]string{
		"maker": call(settlement, "nonceBitmap", maker, big.NewInt(0)).String(),
		"taker": call(settlement, "nonceBitmap", taker, big.NewInt(0)).String(),
		"owner": call(settlement, "nonceBitmap", owner, big.NewInt(0)).String(),
	}
	res.Vault = map[string]string{
		"makerA": call(vault, "balanceOf", tokenAAddr, maker).String(),
		"makerB": call(vault, "balanceOf", tokenBAddr, maker).String(),
		"takerA": call(vault, "balanceOf", tokenAAddr, taker).String(),
		"takerB": call(vault, "balanceOf", tokenBAddr, taker).String(),
		"ownerA": call(vault, "balanceOf", tokenAAddr, owner).String(),
		"ownerB": call(vault, "balanceOf", tokenBAddr, owner).String(),
	}
	res.FeeDistributor = map[string]string{
		"a": call(tokenA, "balanceOf", feeDistAddr).String(),
		"b": call(tokenB, "balanceOf", feeDistAddr).String(),
	}
	res.Developer = map[string]string{
		"a": call(tokenA, "balanceOf", dev).String(),
		"b": call(tokenB, "balanceOf", dev).String(),
	}

	raw, _ := json.MarshalIndent(res, "", "  ")
	t.Logf("multileg node result:\n%s", raw)
	if out := os.Getenv("BIT100_MULTILEG_OUT"); out != "" {
		if err := os.WriteFile(out, raw, 0o644); err != nil {
			t.Fatalf("write result: %v", err)
		}
	}
}

func bigIntOrZero(s string) *big.Int {
	if s == "" {
		return big.NewInt(0)
	}
	v, _ := new(big.Int).SetString(s, 10)
	return v
}
