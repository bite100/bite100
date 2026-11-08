package settlement

// 市价单本地 anvil 端到端验证（第十七轮，设计见 docs/market-orders.md）：
// 两档限价卖单挂簿并落锁 → 市价买单（保护价 2.2）打过去 → 逐档按 maker 价
// 成交（50@2.0 + 30@2.1）→ 全部成交上链结算 → 价格改善余量锁定（按保护价
// 锁 176 TKB、实际消费 163 TKB、余 13 TKB）经 ReleaseRemainderAfterSettlement
// 精确释放并读回归零；另含保护价止步用例（保护价 2.05 同时低于簿上残余
// 的 2.1 档与新挂的 3.0 档 → 零成交、全额锁定立即释放、maker 挂单与锁定
// 不受影响）。
// 仅当 BIT100_ANVIL_RPC 存在时运行；绝不连接外部网络。

import (
	"context"
	"crypto/ecdsa"
	"math/big"
	"os"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"

	"github.com/P2P-P2P/p2p/node/internal/match"
	"github.com/P2P-P2P/p2p/node/internal/storage"
)

func TestAnvilMarketOrderE2E(t *testing.T) {
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
		t.Fatal(err)
	}
	if chainID.Int64() != 31337 {
		t.Fatalf("expected anvil chain id 31337, got %s", chainID)
	}

	ownerKey, err := crypto.HexToECDSA(anvilOwnerKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	owner := crypto.PubkeyToAddress(ownerKey.PublicKey)
	maker1Key, _ := crypto.GenerateKey()
	maker2Key, _ := crypto.GenerateKey()
	takerKey, _ := crypto.GenerateKey()
	maker1 := crypto.PubkeyToAddress(maker1Key.PublicKey)
	maker2 := crypto.PubkeyToAddress(maker2Key.PublicKey)
	taker := crypto.PubkeyToAddress(takerKey.PublicKey)
	t.Logf("owner=%s maker1=%s maker2=%s taker=%s", owner, maker1, maker2, taker)

	e18 := new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)
	for _, to := range []common.Address{maker1, maker2, taker} {
		nonce, err := client.PendingNonceAt(ctx, owner)
		if err != nil {
			t.Fatal(err)
		}
		gasPrice, err := client.SuggestGasPrice(ctx)
		if err != nil {
			t.Fatal(err)
		}
		tx := types.NewTransaction(nonce, to, e18, 21000, gasPrice, nil)
		signed, err := types.SignTx(tx, types.LatestSignerForChainID(chainID), ownerKey)
		if err != nil {
			t.Fatal(err)
		}
		if err := client.SendTransaction(ctx, signed); err != nil {
			t.Fatal(err)
		}
		if _, err := bind.WaitMined(ctx, client, signed); err != nil {
			t.Fatal(err)
		}
	}

	// ---- 部署 ----
	supply := new(big.Int).Mul(big.NewInt(1000000), e18)
	tokenArt := loadArtifact(t, "MockERC20")
	tokenAAddr, tokenA := deploy(t, client, ownerKey, tokenArt, "TokenA", "TKA", supply)
	tokenBAddr, tokenB := deploy(t, client, ownerKey, tokenArt, "TokenB", "TKB", supply)
	vaultAddr, vault := deploy(t, client, ownerKey, loadArtifact(t, "Vault"))
	feeDistAddr, _ := deploy(t, client, ownerKey, loadArtifact(t, "FeeDistributor"))
	settlementAddr, settlement := deploy(t, client, ownerKey, loadArtifact(t, "Settlement"), vaultAddr, feeDistAddr)

	call := func(contract *bind.BoundContract, method string, args ...interface{}) []interface{} {
		var out []interface{}
		if err := contract.Call(&bind.CallOpts{Context: ctx}, &out, method, args...); err != nil {
			t.Fatalf("call %s: %v", method, err)
		}
		return out
	}
	do := func(contract *bind.BoundContract, key *ecdsa.PrivateKey, method string, args ...interface{}) *types.Transaction {
		opts := transactor(t, client, key)
		tx, err := contract.Transact(opts, method, args...)
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
	expect := func(name string, got, want *big.Int) {
		t.Helper()
		if got.Cmp(want) != 0 {
			t.Fatalf("%s = %s, want %s", name, got, want)
		}
		t.Logf("assert %s = %s OK", name, got)
	}
	tokens := func(n int64) *big.Int { return new(big.Int).Mul(big.NewInt(n), e18) }

	do(vault, ownerKey, "setSettlement", settlementAddr)
	do(vault, ownerKey, "setLocker", owner, true)

	match.SetDomain(chainID, settlementAddr)
	now := time.Now().Unix()
	pair := "TKA/TKB"
	pairTokens := match.PairTokens{Token0: tokenAAddr.Hex(), Token1: tokenBAddr.Hex()}

	sign := func(o *storage.Order, key *ecdsa.PrivateKey) *storage.SignedOrder {
		sig, err := match.SignOrder(key, match.BuildSignedOrder(o, &pairTokens))
		if err != nil {
			t.Fatal(err)
		}
		o.Signature = sig
		so := match.BuildSignedOrder(o, &pairTokens)
		return so
	}
	currentNonce := func(user common.Address) uint64 {
		return call(settlement, "getCurrentNonce", user)[0].(*big.Int).Uint64()
	}

	// ---- 充值：maker1/maker2 各 60 TKA，taker 200 TKB ----
	maxUint := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	for _, m := range []struct {
		addr common.Address
		key  *ecdsa.PrivateKey
	}{{maker1, maker1Key}, {maker2, maker2Key}} {
		do(tokenA, ownerKey, "transfer", m.addr, tokens(1000))
		do(tokenA, m.key, "approve", vaultAddr, maxUint)
		do(vault, m.key, "deposit", tokenAAddr, tokens(60))
	}
	do(tokenB, ownerKey, "transfer", taker, tokens(1000))
	do(tokenB, takerKey, "approve", vaultAddr, maxUint)
	do(vault, takerKey, "deposit", tokenBAddr, tokens(200))

	// ================= 场景一：逐档成交 + 价格改善余量释放 =================
	ask1 := &storage.Order{OrderID: "mkt-ask-1", Trader: maker1.Hex(), Pair: pair, Side: "sell",
		Price: "2000000000000000000", Amount: "50000000000000000000", Filled: "0", Status: "open",
		Nonce: 0, CreatedAt: now, ExpiresAt: now + 3600}
	ask2 := &storage.Order{OrderID: "mkt-ask-2", Trader: maker2.Hex(), Pair: pair, Side: "sell",
		Price: "2100000000000000000", Amount: "50000000000000000000", Filled: "0", Status: "open",
		Nonce: 0, CreatedAt: now + 1, ExpiresAt: now + 3600}
	sign(ask1, maker1Key)
	sign(ask2, maker2Key)

	// 市价买单：数量 80，保护价 2.2（签名），execType 为未签名执行指令
	mktBuy := &storage.Order{OrderID: "mkt-buy-1", Trader: taker.Hex(), Pair: pair, Side: "buy",
		Price: "2200000000000000000", Amount: "80000000000000000000", Filled: "0", Status: "open",
		Nonce: 0, CreatedAt: now + 2, ExpiresAt: now + 3600, ExecType: storage.ExecTypeMarket}
	takerSO := sign(mktBuy, takerKey)

	eng := match.NewEngine(map[string]match.PairTokens{pair: pairTokens})
	if !eng.AddOrder(ask1) || !eng.AddOrder(ask2) {
		t.Fatal("AddOrder(asks) rejected")
	}

	// 落锁：maker 卖单各锁 50 TKA；taker 按保护价锁 80 × 2.2 = 176 TKB
	for _, o := range []*storage.Order{ask1, ask2} {
		if _, _, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), anvilOwnerKeyHex, match.BuildSignedOrder(o, &pairTokens)); err != nil {
			t.Fatalf("LockOrder(%s): %v", o.OrderID, err)
		}
	}
	if _, _, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), anvilOwnerKeyHex, takerSO); err != nil {
		t.Fatalf("LockOrder(taker market): %v", err)
	}
	_, lockedT, _, err := VaultBalances(ctx, client, vaultAddr.Hex(), taker, tokenBAddr)
	if err != nil {
		t.Fatal(err)
	}
	expect("taker locked TKB (protection 176)", lockedT, tokens(176))

	// IOC 执行：逐档成交、永不入簿
	exec := eng.ExecuteMarketOrder(mktBuy)
	if len(exec.Trades) != 2 {
		t.Fatalf("expected 2 trades, got %d", len(exec.Trades))
	}
	if !exec.FullyFilled {
		t.Fatalf("expected fully filled, executed=%s remainder=%s", exec.Executed, exec.Remainder)
	}
	tradeQtyPrice := func(tr *storage.Trade) (*big.Int, *big.Int) {
		fill, err := TradeToFill(tr)
		if err != nil {
			t.Fatal(err)
		}
		return fill.AmountIn, fill.AmountOut
	}
	q0, p0 := tradeQtyPrice(exec.Trades[0])
	expect("trade0 qty (TKA)", q0, tokens(50))
	expect("trade0 quote (TKB @2.0)", p0, tokens(100))
	q1, p1 := tradeQtyPrice(exec.Trades[1])
	expect("trade1 qty (TKA)", q1, tokens(30))
	expect("trade1 quote (TKB @2.1)", p1, tokens(63))
	if bids, _ := eng.GetOrderbook(pair); len(bids) != 0 {
		t.Fatalf("market taker must not rest in book, got %d bids", len(bids))
	}

	// 全部成交上链结算
	for _, tr := range exec.Trades {
		if _, err := SubmitTrade(ctx, tr, rpc, settlementAddr.Hex(), anvilOwnerKeyHex); err != nil {
			t.Fatalf("SubmitTrade: %v", err)
		}
	}

	bal := func(token *bind.BoundContract, user common.Address) *big.Int {
		return call(token, "balanceOf", user)[0].(*big.Int)
	}
	// Vault 内余额以 Vault.balanceOf 读（结算在 Vault 账本内划转）
	vbal := func(tokenAddr, user common.Address) *big.Int {
		return call(vault, "balanceOf", tokenAddr, user)[0].(*big.Int)
	}
	_ = bal
	expect("maker1 TKB (100 - 0.01 fee)", vbal(tokenBAddr, maker1), wei("99990000000000000000"))
	expect("maker2 TKB (63 - 0.0063 fee)", vbal(tokenBAddr, maker2), wei("62993700000000000000"))
	expect("taker TKA (80 - 0.008 fee)", vbal(tokenAAddr, taker), wei("79992000000000000000"))
	expect("taker TKB balance (200 - 163)", vbal(tokenBAddr, taker), tokens(37))
	// 结算后 taker 锁定应剩价格改善余量 176 - 163 = 13 TKB
	_, lockedT2, availT2, err := VaultBalances(ctx, client, vaultAddr.Hex(), taker, tokenBAddr)
	if err != nil {
		t.Fatal(err)
	}
	expect("taker locked TKB before remainder release (13)", lockedT2, tokens(13))
	expect("taker available TKB before release (37 - 13)", availT2, tokens(24))

	// 精确释放：等待-释放助手在剩余量 == 13 时释放
	tx, err := ReleaseRemainderAfterSettlement(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), anvilOwnerKeyHex, takerSO, tokens(13), 200*time.Millisecond, 30*time.Second)
	if err != nil {
		t.Fatalf("ReleaseRemainderAfterSettlement: %v", err)
	}
	if tx == "" {
		t.Fatal("expected a release tx")
	}
	t.Logf("remainder release tx=%s", tx)
	_, lockedT3, availT3, err := VaultBalances(ctx, client, vaultAddr.Hex(), taker, tokenBAddr)
	if err != nil {
		t.Fatal(err)
	}
	expect("taker locked TKB after release", lockedT3, big.NewInt(0))
	expect("taker available TKB after release", availT3, tokens(37))

	// maker2 的限价单只成交 30/50：剩余 20 TKA 的锁定原样保留（挂单仍有效）
	_, lockedM2, _, err := VaultBalances(ctx, client, vaultAddr.Hex(), maker2, tokenAAddr)
	if err != nil {
		t.Fatal(err)
	}
	expect("maker2 locked TKA (resting remainder 20)", lockedM2, tokens(20))

	// ================= 场景二：保护价止步 → 零成交 → 全额释放 =================
	ask3 := &storage.Order{OrderID: "mkt-ask-3", Trader: maker1.Hex(), Pair: pair, Side: "sell",
		Price: "3000000000000000000", Amount: "10000000000000000000", Filled: "0", Status: "open",
		Nonce: int64(currentNonce(maker1)), CreatedAt: now + 10, ExpiresAt: now + 3600}
	sign(ask3, maker1Key)
	mktBuy2 := &storage.Order{OrderID: "mkt-buy-2", Trader: taker.Hex(), Pair: pair, Side: "buy",
		Price: "2050000000000000000", Amount: "10000000000000000000", Filled: "0", Status: "open",
		Nonce: int64(currentNonce(taker)), CreatedAt: now + 11, ExpiresAt: now + 3600, ExecType: storage.ExecTypeMarket}
	takerSO2 := sign(mktBuy2, takerKey)

	if !eng.AddOrder(ask3) {
		t.Fatal("AddOrder(ask3) rejected")
	}
	if _, _, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), anvilOwnerKeyHex, match.BuildSignedOrder(ask3, &pairTokens)); err != nil {
		t.Fatalf("LockOrder(ask3): %v", err)
	}
	// taker 按保护价 2.05 锁 10 × 2.05 = 20.5 TKB（可用 37 足够）
	if _, _, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), anvilOwnerKeyHex, takerSO2); err != nil {
		t.Fatalf("LockOrder(taker market 2): %v", err)
	}
	exec2 := eng.ExecuteMarketOrder(mktBuy2)
	if len(exec2.Trades) != 0 {
		t.Fatalf("protection price must stop execution: expected 0 trades, got %d", len(exec2.Trades))
	}
	// 零成交 → 立即全额释放（handler 语义，此处直接调结算包原语复证）
	digest, err := OrderDigest(ctx, client, settlementAddr.Hex(), takerSO2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReleaseOrderLock(ctx, rpc, vaultAddr.Hex(), anvilOwnerKeyHex, digest); err != nil {
		t.Fatalf("ReleaseOrderLock(zero-fill): %v", err)
	}
	_, lockedT4, availT4, err := VaultBalances(ctx, client, vaultAddr.Hex(), taker, tokenBAddr)
	if err != nil {
		t.Fatal(err)
	}
	expect("taker locked TKB after zero-fill release", lockedT4, big.NewInt(0))
	expect("taker available TKB after zero-fill release", availT4, tokens(37))
	// maker1 的 3.0 档未受影响：仍在盘口且锁定 10 TKA 在
	_, asks := eng.GetOrderbook(pair)
	found := false
	for _, a := range asks {
		if a.OrderID == "mkt-ask-3" {
			found = true
		}
	}
	if !found {
		t.Fatal("ask3 should still rest in the book")
	}
	_, lockedM1, _, err := VaultBalances(ctx, client, vaultAddr.Hex(), maker1, tokenAAddr)
	if err != nil {
		t.Fatal(err)
	}
	expect("maker1 locked TKA (ask3 intact)", lockedM1, tokens(10))
}
