package settlement

// 第十五轮挂单锁定全闭环 E2E（真实链，env 门控，默认不触发）：
// 存款 → 下单落锁（读回 locked）→ 超额提取被拒 → 撤单释放 → 再下单 →
// 撮合落锁 → 成交结算（手续费 99% 进 FD / 1% 到开发者）→ 锁定清零 → 重放被拒。
//
// 环境变量与 e2e_sepolia_test.go 相同（BIT100_SEPOLIA_* 命名沿用，值指向目标链）：
//   BIT100_SEPOLIA_RPC / BIT100_SEPOLIA_OWNER_KEY / BIT100_SEPOLIA_MAKER_KEY /
//   BIT100_SEPOLIA_TAKER_KEY / BIT100_SEPOLIA_VAULT / BIT100_SEPOLIA_FEEDIST /
//   BIT100_SEPOLIA_SETTLEMENT / BIT100_SEPOLIA_TOKENA / BIT100_SEPOLIA_TOKENB
//   可选 BIT100_E2E_CHAIN_ID（默认 11155111；Base Sepolia 传 84532）
// 目标部署必须是第十五轮新部署（Vault 带锁定接口、locker=owner）。

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"os"
	"strconv"
	"strings"
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

func TestChainLockingLoopE2E(t *testing.T) {
	rpc := os.Getenv("BIT100_SEPOLIA_RPC")
	if rpc == "" {
		t.Skip("BIT100_SEPOLIA_RPC not set; skipping locking loop e2e")
	}
	ownerKey := sepKey(t, "BIT100_SEPOLIA_OWNER_KEY")
	makerKey := sepKey(t, "BIT100_SEPOLIA_MAKER_KEY")
	takerKey := sepKey(t, "BIT100_SEPOLIA_TAKER_KEY")
	vaultAddr := sepAddr(t, "BIT100_SEPOLIA_VAULT")
	feeDistAddr := sepAddr(t, "BIT100_SEPOLIA_FEEDIST")
	settlementAddr := sepAddr(t, "BIT100_SEPOLIA_SETTLEMENT")
	tokenAAddr := sepAddr(t, "BIT100_SEPOLIA_TOKENA")
	tokenBAddr := sepAddr(t, "BIT100_SEPOLIA_TOKENB")
	ownerPrivHex := strings.TrimPrefix(os.Getenv("BIT100_SEPOLIA_OWNER_KEY"), "0x")

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
	expectedChainID := int64(11155111)
	if v := os.Getenv("BIT100_E2E_CHAIN_ID"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			t.Fatalf("bad BIT100_E2E_CHAIN_ID %q", v)
		}
		expectedChainID = n
	}
	if chainID.Int64() != expectedChainID {
		t.Fatalf("expected chain id %d, got %s", expectedChainID, chainID)
	}

	owner := crypto.PubkeyToAddress(ownerKey.PublicKey)
	maker := crypto.PubkeyToAddress(makerKey.PublicKey)
	taker := crypto.PubkeyToAddress(takerKey.PublicKey)
	t.Logf("chain=%s owner=%s maker=%s taker=%s", chainID, owner, maker, taker)
	t.Logf("vault=%s settlement=%s tokenA=%s tokenB=%s", vaultAddr, settlementAddr, tokenAAddr, tokenBAddr)

	tokenArt := loadArtifact(t, "MockERC20")
	vaultArt := loadArtifact(t, "Vault")
	settlementArt := loadArtifact(t, "Settlement")
	feeDistArt := loadArtifact(t, "FeeDistributor")
	tokenAContract := bind.NewBoundContract(tokenAAddr, tokenArt.ABI, client, client, client)
	tokenBContract := bind.NewBoundContract(tokenBAddr, tokenArt.ABI, client, client, client)
	vault := bind.NewBoundContract(vaultAddr, vaultArt.ABI, client, client, client)
	settlement := bind.NewBoundContract(settlementAddr, settlementArt.ABI, client, client, client)
	feeDist := bind.NewBoundContract(feeDistAddr, feeDistArt.ABI, client, client, client)

	call := func(contract *bind.BoundContract, method string, args ...interface{}) []interface{} {
		var out []interface{}
		if err := contract.Call(&bind.CallOpts{Context: ctx}, &out, method, args...); err != nil {
			t.Fatalf("call %s: %v", method, err)
		}
		return out
	}
	do := func(contract *bind.BoundContract, key *ecdsa.PrivateKey, method string, args ...interface{}) *types.Transaction {
		var tx *types.Transaction
		var err error
		for attempt := 1; attempt <= 6; attempt++ {
			opts := transactor(t, client, key)
			tx, err = contract.Transact(opts, method, args...)
			if err == nil {
				break
			}
			t.Logf("%s attempt %d failed (retrying): %v", method, attempt, err)
			time.Sleep(15 * time.Second)
		}
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
		t.Logf("tx %s: %s", method, tx.Hash().Hex())
		return tx
	}
	// doExpectFail 断言交易被链上拒绝（发送期估计失败或回执 status=0 均算拒绝）。
	doExpectFail := func(contract *bind.BoundContract, key *ecdsa.PrivateKey, method string, args ...interface{}) {
		opts := transactor(t, client, key)
		tx, err := contract.Transact(opts, method, args...)
		if err != nil {
			t.Logf("%s correctly rejected at send: %v", method, err)
			return
		}
		receipt, err := bind.WaitMined(ctx, client, tx)
		if err != nil {
			t.Fatalf("%s wait: %v", method, err)
		}
		if receipt.Status == types.ReceiptStatusSuccessful {
			t.Fatalf("%s should have been rejected but succeeded, tx=%s", method, tx.Hash().Hex())
		}
		t.Logf("%s correctly reverted on-chain, tx=%s", method, tx.Hash().Hex())
	}

	e18 := new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)
	amt100 := new(big.Int).Mul(big.NewInt(100), e18)
	amt200 := new(big.Int).Mul(big.NewInt(200), e18)
	amt1000 := new(big.Int).Mul(big.NewInt(1000), e18)

	// ---- 注资 + 存款：maker 存 1000 TKA、taker 存 1000 TKB ----
	do(tokenAContract, ownerKey, "transfer", maker, amt1000)
	do(tokenBContract, ownerKey, "transfer", taker, amt1000)
	maxUint := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	do(tokenAContract, makerKey, "approve", vaultAddr, maxUint)
	do(vault, makerKey, "deposit", tokenAAddr, amt1000)
	do(tokenBContract, takerKey, "approve", vaultAddr, maxUint)
	do(vault, takerKey, "deposit", tokenBAddr, amt1000)

	makerNonce := call(settlement, "getCurrentNonce", maker)[0].(*big.Int).Int64()
	takerNonce := call(settlement, "getCurrentNonce", taker)[0].(*big.Int).Int64()
	match.SetDomain(chainID, settlementAddr)
	pair := "TKA/TKB"
	pairTokens := match.PairTokens{Token0: tokenAAddr.Hex(), Token1: tokenBAddr.Hex()}
	now := time.Now().Unix()

	sign := func(key *ecdsa.PrivateKey, o *storage.Order) *storage.SignedOrder {
		so := match.BuildSignedOrder(o, &pairTokens)
		sig, err := match.SignOrder(key, so)
		if err != nil {
			t.Fatal(err)
		}
		o.Signature = sig
		so.Signature = sig
		return so
	}
	vaultBal := func(user, token common.Address) (bal, locked, avail *big.Int) {
		b, l, a, err := VaultBalances(ctx, client, vaultAddr.Hex(), user, token)
		if err != nil {
			t.Fatalf("VaultBalances: %v", err)
		}
		return b, l, a
	}

	// ---- 订单 A：落锁 → 读回 → 超额提取被拒 → 撤单释放 ----
	orderA := &storage.Order{
		OrderID: fmt.Sprintf("loop15-maker-a-%d", now), Trader: maker.Hex(), Pair: pair, Side: "sell",
		Price: "2000000000000000000", Amount: "100000000000000000000",
		Filled: "0", Status: "open", Nonce: makerNonce, CreatedAt: now, ExpiresAt: now + 3600,
	}
	soA := sign(makerKey, orderA)
	digestA, lockTxA, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), ownerPrivHex, soA)
	if err != nil {
		t.Fatalf("LockOrder(A): %v", err)
	}
	t.Logf("order A locked tx=%s digest=%s", lockTxA, digestA.Hex())
	{
		bal, locked, avail := vaultBal(maker, tokenAAddr)
		if bal.Cmp(amt1000) != 0 || locked.Cmp(amt100) != 0 || avail.Cmp(new(big.Int).Mul(big.NewInt(900), e18)) != 0 {
			t.Fatalf("after lock A: balance=%s locked=%s available=%s, want 1000/100/900 (TKA)", bal, locked, avail)
		}
		t.Logf("lock A verified: balance=1000 locked=100 available=900 TKA")
	}
	// 超额提取：可用 900，提 901 必须被拒；提可用内 0 对照略（避免扰动后续数额）
	doExpectFail(vault, makerKey, "withdraw", tokenAAddr, new(big.Int).Add(new(big.Int).Mul(big.NewInt(900), e18), big.NewInt(1)))
	// 撤单释放（locker 按摘要释放）
	relTx, err := ReleaseOrderLock(ctx, rpc, vaultAddr.Hex(), ownerPrivHex, digestA)
	if err != nil {
		t.Fatalf("ReleaseOrderLock(A): %v", err)
	}
	t.Logf("order A lock released tx=%s", relTx)
	{
		_, locked, avail := vaultBal(maker, tokenAAddr)
		if locked.Sign() != 0 || avail.Cmp(amt1000) != 0 {
			t.Fatalf("after release A: locked=%s available=%s, want 0/1000", locked, avail)
		}
		t.Logf("release A verified: locked=0 available=1000 TKA")
	}

	// ---- 订单 B + taker 单：撮合 → 双边落锁 → 结算 → 分账断言 → 重放被拒 ----
	orderB := &storage.Order{
		OrderID: fmt.Sprintf("loop15-maker-b-%d", now), Trader: maker.Hex(), Pair: pair, Side: "sell",
		Price: "2000000000000000000", Amount: "100000000000000000000",
		Filled: "0", Status: "open", Nonce: makerNonce, CreatedAt: now, ExpiresAt: now + 3600,
	}
	sign(makerKey, orderB)
	takerOrder := &storage.Order{
		OrderID: fmt.Sprintf("loop15-taker-%d", now), Trader: taker.Hex(), Pair: pair, Side: "buy",
		Price: "2000000000000000000", Amount: "100000000000000000000",
		Filled: "0", Status: "open", Nonce: takerNonce, CreatedAt: now, ExpiresAt: now + 3600,
	}
	soT := sign(takerKey, takerOrder)

	eng := match.NewEngine(map[string]match.PairTokens{pair: pairTokens})
	if !eng.AddOrder(orderB) {
		t.Fatal("AddOrder(maker B) rejected")
	}
	trades := eng.Match(takerOrder)
	if len(trades) != 1 {
		t.Fatalf("expected 1 trade, got %d", len(trades))
	}
	trade := trades[0]

	if _, tx, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), ownerPrivHex, trade.MakerOrder); err != nil {
		t.Fatalf("LockOrder(B): %v", err)
	} else {
		t.Logf("order B locked tx=%s", tx)
	}
	if _, tx, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), ownerPrivHex, soT); err != nil {
		t.Fatalf("LockOrder(taker): %v", err)
	} else {
		t.Logf("taker order locked tx=%s", tx)
	}
	{
		_, lockedM, _ := vaultBal(maker, tokenAAddr)
		_, lockedT, _ := vaultBal(taker, tokenBAddr)
		if lockedM.Cmp(amt100) != 0 || lockedT.Cmp(amt200) != 0 {
			t.Fatalf("locks before settle: maker=%s (want 100 TKA) taker=%s (want 200 TKB)", lockedM, lockedT)
		}
	}

	developer := call(feeDist, "developerAddress")[0].(common.Address)
	wallet := func(contract *bind.BoundContract, user common.Address) *big.Int {
		return call(contract, "balanceOf", user)[0].(*big.Int)
	}
	preFDA, preFDB := wallet(tokenAContract, feeDistAddr), wallet(tokenBContract, feeDistAddr)
	preDevA, preDevB := wallet(tokenAContract, developer), wallet(tokenBContract, developer)

	settleTx, err := SubmitTrade(ctx, trade, rpc, settlementAddr.Hex(), ownerPrivHex)
	if err != nil {
		t.Fatalf("SubmitTrade: %v", err)
	}
	t.Logf("settle tx: %s", settleTx)

	// 增量断言（公共 RPC 读数可能滞后一区块，轮询收敛）
	// 手续费：maker 侧 TKB 费 0.02、taker 侧 TKA 费 0.01；FD 得 99%，开发者得 1%。
	wantFDA := new(big.Int).Add(preFDA, wei("9900000000000000"))   // +0.0099 TKA
	wantFDB := new(big.Int).Add(preFDB, wei("19800000000000000"))  // +0.0198 TKB
	wantDevA := new(big.Int).Add(preDevA, wei("100000000000000"))  // +0.0001 TKA
	wantDevB := new(big.Int).Add(preDevB, wei("200000000000000"))  // +0.0002 TKB
	deadline := time.Now().Add(3 * time.Minute)
	for {
		bad := []string{}
		eq := func(name string, got, want *big.Int) {
			if got.Cmp(want) != 0 {
				bad = append(bad, fmt.Sprintf("%s=%s want %s", name, got, want))
			}
		}
		makerTKA, _, _ := vaultBal(maker, tokenAAddr)
		makerTKB, _, _ := vaultBal(maker, tokenBAddr)
		takerTKA, _, _ := vaultBal(taker, tokenAAddr)
		takerTKB, _, _ := vaultBal(taker, tokenBAddr)
		eq("maker TKA", makerTKA, new(big.Int).Mul(big.NewInt(900), e18))
		eq("maker TKB", makerTKB, wei("199980000000000000000"))
		eq("taker TKA", takerTKA, wei("99990000000000000000"))
		eq("taker TKB", takerTKB, new(big.Int).Mul(big.NewInt(800), e18))
		eq("FD TKA", wallet(tokenAContract, feeDistAddr), wantFDA)
		eq("FD TKB", wallet(tokenBContract, feeDistAddr), wantFDB)
		eq("dev TKA", wallet(tokenAContract, developer), wantDevA)
		eq("dev TKB", wallet(tokenBContract, developer), wantDevB)
		if len(bad) == 0 {
			t.Logf("settlement deltas verified (fees: 99%% FD / 1%% developer)")
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("settlement deltas not converged: %s", strings.Join(bad, "; "))
		}
		time.Sleep(10 * time.Second)
	}
	{
		_, lockedM, _ := vaultBal(maker, tokenAAddr)
		_, lockedT, _ := vaultBal(taker, tokenBAddr)
		if lockedM.Sign() != 0 || lockedT.Sign() != 0 {
			t.Fatalf("locks after settle: maker=%s taker=%s, want 0/0", lockedM, lockedT)
		}
		t.Logf("locks cleared after settle")
	}

	// ---- 重放被拒 ----
	if _, err := SubmitTrade(ctx, trade, rpc, settlementAddr.Hex(), ownerPrivHex); err == nil {
		t.Fatal("replay of the same trade should have failed on-chain")
	} else {
		t.Logf("replay correctly rejected: %v", err)
	}
}
