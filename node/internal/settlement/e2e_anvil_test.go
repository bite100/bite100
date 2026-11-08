package settlement

// 本地 anvil 端到端验证（P0-3）：部署合约 → 签名订单 → 节点撮合 → SubmitTrade 验签结算上链 → 链上状态断言。
// 仅当环境变量 BIT100_ANVIL_RPC 存在时运行（见 scripts/anvil-e2e.sh）；绝不连接外部网络。
// 断言口径：maker 卖 100 TKA、价 2 TKB/TKA，taker 全额吃单；费率 1bp 双边：
// maker 得 200 - 0.02 = 199.98 TKB，taker 得 100 - 0.01 = 99.99 TKA，双方 nonce 各消耗至 1；
// 同一成交再次提交必须被链上拒绝（累计超签名量/防重放）。

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"

	"github.com/P2P-P2P/p2p/node/internal/match"
	"github.com/P2P-P2P/p2p/node/internal/storage"
)

const anvilOwnerKeyHex = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" // anvil 账户 #0（公开测试私钥）

type artifact struct {
	ABI      abi.ABI
	Bytecode []byte
}

func loadArtifact(t *testing.T, name string) artifact {
	t.Helper()
	path := filepath.Join("..", "..", "..", "contracts", "out", name+".sol", name+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read artifact %s: %v (先运行 forge build)", name, err)
	}
	var doc struct {
		ABI      json.RawMessage `json:"abi"`
		Bytecode struct {
			Object string `json:"object"`
		} `json:"bytecode"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse artifact %s: %v", name, err)
	}
	parsed, err := abi.JSON(strings.NewReader(string(doc.ABI)))
	if err != nil {
		t.Fatalf("parse abi %s: %v", name, err)
	}
	return artifact{ABI: parsed, Bytecode: common.FromHex(doc.Bytecode.Object)}
}

func transactor(t *testing.T, client *ethclient.Client, key *ecdsa.PrivateKey) *bind.TransactOpts {
	t.Helper()
	chainID, err := client.ChainID(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	opts, err := bind.NewKeyedTransactorWithChainID(key, chainID)
	if err != nil {
		t.Fatal(err)
	}
	opts.Context = context.Background()
	return opts
}

func deploy(t *testing.T, client *ethclient.Client, key *ecdsa.PrivateKey, art artifact, args ...interface{}) (common.Address, *bind.BoundContract) {
	t.Helper()
	opts := transactor(t, client, key)
	addr, tx, contract, err := bind.DeployContract(opts, art.ABI, art.Bytecode, client, args...)
	if err != nil {
		t.Fatalf("deploy: %v", err)
	}
	receipt, err := bind.WaitMined(context.Background(), client, tx)
	if err != nil {
		t.Fatalf("deploy wait: %v", err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		t.Fatalf("deploy reverted, tx=%s", tx.Hash().Hex())
	}
	return addr, contract
}

// wei 解析十进制大整数（超出 int64 的断言值用）
func wei(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("bad bigint: " + s)
	}
	return v
}

func TestAnvilE2E(t *testing.T) {
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
	makerKey, _ := crypto.GenerateKey()
	takerKey, _ := crypto.GenerateKey()
	maker := crypto.PubkeyToAddress(makerKey.PublicKey)
	taker := crypto.PubkeyToAddress(takerKey.PublicKey)
	t.Logf("owner=%s maker=%s taker=%s", owner, maker, taker)

	// 给 maker/taker 各转 1 ETH 作为 gas
	for _, to := range []common.Address{maker, taker} {
		nonce, err := client.PendingNonceAt(ctx, owner)
		if err != nil {
			t.Fatal(err)
		}
		gasPrice, err := client.SuggestGasPrice(ctx)
		if err != nil {
			t.Fatal(err)
		}
		tx := types.NewTransaction(nonce, to, new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil), 21000, gasPrice, nil)
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

	// ---- 部署（本地 anvil） ----
	e18 := new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)
	supply := new(big.Int).Mul(big.NewInt(1000000), e18)
	tokenAArt := loadArtifact(t, "MockERC20")
	tokenAAddr, tokenA := deploy(t, client, ownerKey, tokenAArt, "TokenA", "TKA", supply)
	tokenBAddr, tokenB := deploy(t, client, ownerKey, tokenAArt, "TokenB", "TKB", supply)
	vaultArt := loadArtifact(t, "Vault")
	vaultAddr, vault := deploy(t, client, ownerKey, vaultArt)
	feeDistArt := loadArtifact(t, "FeeDistributor")
	feeDistAddr, _ := deploy(t, client, ownerKey, feeDistArt)
	settlementArt := loadArtifact(t, "Settlement")
	settlementAddr, settlement := deploy(t, client, ownerKey, settlementArt, vaultAddr, feeDistAddr)
	t.Logf("deployed tokenA=%s tokenB=%s vault=%s feeDistributor=%s settlement=%s",
		tokenAAddr, tokenBAddr, vaultAddr, feeDistAddr, settlementAddr)

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

	do(vault, ownerKey, "setSettlement", settlementAddr)
	do(vault, ownerKey, "setLocker", owner, true) // 第十五轮：owner 为测试 locker

	// ---- 充值到 Vault ----
	amt100 := new(big.Int).Mul(big.NewInt(100), e18)
	amt200 := new(big.Int).Mul(big.NewInt(200), e18)
	amt1000 := new(big.Int).Mul(big.NewInt(1000), e18)
	do(tokenA, ownerKey, "transfer", maker, amt1000)
	do(tokenB, ownerKey, "transfer", taker, amt1000)
	maxUint := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	do(tokenA, makerKey, "approve", vaultAddr, maxUint)
	do(vault, makerKey, "deposit", tokenAAddr, amt100)
	do(tokenB, takerKey, "approve", vaultAddr, maxUint)
	do(vault, takerKey, "deposit", tokenBAddr, amt200)

	// ---- 签名域切换到本地链 + 本次部署的 Settlement ----
	match.SetDomain(chainID, settlementAddr)

	now := time.Now().Unix()
	pair := "TKA/TKB"
	pairTokens := match.PairTokens{Token0: tokenAAddr.Hex(), Token1: tokenBAddr.Hex()}

	makerOrder := &storage.Order{
		OrderID: "e2e-maker-1", Trader: maker.Hex(), Pair: pair, Side: "sell",
		Price: "2000000000000000000", Amount: "100000000000000000000",
		Filled: "0", Status: "open", Nonce: 0, CreatedAt: now, ExpiresAt: now + 3600,
	}
	sigM, err := match.SignOrder(makerKey, match.BuildSignedOrder(makerOrder, &pairTokens))
	if err != nil {
		t.Fatal(err)
	}
	makerOrder.Signature = sigM

	takerOrder := &storage.Order{
		OrderID: "e2e-taker-1", Trader: taker.Hex(), Pair: pair, Side: "buy",
		Price: "2000000000000000000", Amount: "100000000000000000000",
		Filled: "0", Status: "open", Nonce: 0, CreatedAt: now, ExpiresAt: now + 3600,
	}
	sigT, err := match.SignOrder(takerKey, match.BuildSignedOrder(takerOrder, &pairTokens))
	if err != nil {
		t.Fatal(err)
	}
	takerOrder.Signature = sigT

	if ok, err := match.VerifyOrderSignature(makerOrder, &pairTokens); err != nil || !ok {
		t.Fatalf("maker order self-verify failed: ok=%v err=%v", ok, err)
	}
	if ok, err := match.VerifyOrderSignature(takerOrder, &pairTokens); err != nil || !ok {
		t.Fatalf("taker order self-verify failed: ok=%v err=%v", ok, err)
	}

	// ---- 节点撮合 ----
	eng := match.NewEngine(map[string]match.PairTokens{pair: pairTokens})
	if !eng.AddOrder(makerOrder) {
		t.Fatal("AddOrder(maker) rejected")
	}
	trades := eng.Match(takerOrder)
	if len(trades) != 1 {
		t.Fatalf("expected 1 trade, got %d", len(trades))
	}
	trade := trades[0]
	if trade.MakerOrder == nil || trade.TakerOrder == nil {
		t.Fatal("trade missing signed orders")
	}
	t.Logf("matched trade id=%s amount=%s tokenIn=%s tokenOut=%s", trade.TradeID, trade.Amount, trade.TokenIn, trade.TokenOut)

	// ---- 挂单锁定（第十五轮）：未落锁先结算应被拒 ----
	if _, err := SubmitTrade(ctx, trade, rpc, settlementAddr.Hex(), anvilOwnerKeyHex); err == nil {
		t.Fatal("settle without lock should fail (Vault: order not locked)")
	} else {
		t.Logf("settle without lock correctly failed: %v", err)
	}
	// 部署脚本已把 locker 设为部署者（owner）；节点驱动落锁：maker 卖、taker 买
	if _, tx, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), anvilOwnerKeyHex, trade.MakerOrder); err != nil {
		t.Fatalf("LockOrder(maker): %v", err)
	} else {
		t.Logf("maker locked tx=%s", tx)
	}
	if _, tx, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), anvilOwnerKeyHex, trade.TakerOrder); err != nil {
		t.Fatalf("LockOrder(taker): %v", err)
	} else {
		t.Logf("taker locked tx=%s", tx)
	}
	{
		client, err := ethclient.Dial(rpc)
		if err != nil {
			t.Fatalf("dial for lock check: %v", err)
		}
		defer client.Close()
		_, lockedM, _, err := VaultBalances(ctx, client, vaultAddr.Hex(), maker, tokenAAddr)
		if err != nil {
			t.Fatalf("VaultBalances(maker): %v", err)
		}
		if lockedM.Cmp(wei("100000000000000000000")) != 0 {
			t.Fatalf("maker locked = %s, want 100 TKA", lockedM)
		}
		_, lockedT, _, err := VaultBalances(ctx, client, vaultAddr.Hex(), taker, tokenBAddr)
		if err != nil {
			t.Fatalf("VaultBalances(taker): %v", err)
		}
		if lockedT.Cmp(wei("200000000000000000000")) != 0 {
			t.Fatalf("taker locked = %s, want 200 TKB (100 TKA × price 2)", lockedT)
		}
		t.Logf("locks verified: maker 100 TKA / taker 200 TKB")
	}

	// ---- 真实上链结算（owner 作为结算方提交；合约侧验签、消费锁定） ----
	txHash, err := SubmitTrade(ctx, trade, rpc, settlementAddr.Hex(), anvilOwnerKeyHex)
	if err != nil {
		t.Fatalf("SubmitTrade: %v", err)
	}
	t.Logf("settle tx: %s", txHash)

	// ---- 链上状态断言 ----
	bal := func(token, user common.Address) *big.Int {
		out := call(vault, "balanceOf", token, user)
		return out[0].(*big.Int)
	}
	expect := func(name string, got *big.Int, want *big.Int) {
		if got.Cmp(want) != 0 {
			t.Errorf("%s = %s, want %s", name, got, want)
		}
		t.Logf("assert %s = %s OK", name, got)
	}
	expect("maker TKA in vault", bal(tokenAAddr, maker), big.NewInt(0))
	expect("maker TKB in vault", bal(tokenBAddr, maker), wei("199980000000000000000")) // 200 - 0.02 fee
	expect("taker TKB in vault", bal(tokenBAddr, taker), big.NewInt(0))
	expect("taker TKA in vault", bal(tokenAAddr, taker), wei("99990000000000000000")) // 100 - 0.01 fee
	expect("feeDistributor TKA", call(tokenA, "balanceOf", feeDistAddr)[0].(*big.Int), wei("10000000000000000"))
	expect("feeDistributor TKB", call(tokenB, "balanceOf", feeDistAddr)[0].(*big.Int), wei("20000000000000000"))
	expect("maker nonce", call(settlement, "getCurrentNonce", maker)[0].(*big.Int), big.NewInt(1))
	expect("taker nonce", call(settlement, "getCurrentNonce", taker)[0].(*big.Int), big.NewInt(1))

	// ---- 结算后锁定应清零 ----
	{
		client, err := ethclient.Dial(rpc)
		if err != nil {
			t.Fatalf("dial for post-settle lock check: %v", err)
		}
		defer client.Close()
		_, lockedM, _, _ := VaultBalances(ctx, client, vaultAddr.Hex(), maker, tokenAAddr)
		_, lockedT, _, _ := VaultBalances(ctx, client, vaultAddr.Hex(), taker, tokenBAddr)
		if lockedM.Sign() != 0 || lockedT.Sign() != 0 {
			t.Fatalf("locks after settle: maker=%s taker=%s, want 0/0", lockedM, lockedT)
		}
		t.Logf("locks cleared after settle")
	}

	// ---- 重放：同一成交再次提交必须失败 ----
	if _, err := SubmitTrade(ctx, trade, rpc, settlementAddr.Hex(), anvilOwnerKeyHex); err == nil {
		t.Error("replay of the same trade should have failed on-chain")
	} else {
		t.Logf("replay correctly rejected: %v", err)
	}
}

// ---- 金库 ERC-1271 全流程（第二十七轮） ----
//
// 部署新 Settlement（ERC-1271 验签）+ MakerVault（USDT 资产 / BTC 标的 / mock
// BTC/USD 喂价），存款人存入 1000 USDT → 金库签名者代金库买 0.01 BTC →
// taker 卖 0.01 BTC → 两次落锁（第二次验证幂等：不发交易直接成功）→
// SubmitTrade 链上结算 → 断言金库余额/NAV/份额/nonce。纯 ecrecover 验签
// 必须对金库订单返回 false（恢复地址为签名者 ≠ 金库），链上验签返回 true。
func TestAnvilVaultERC1271Settles(t *testing.T) {
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
	ownerKey, err := crypto.HexToECDSA(anvilOwnerKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	owner := crypto.PubkeyToAddress(ownerKey.PublicKey)
	signerKey, _ := crypto.GenerateKey()
	signer := crypto.PubkeyToAddress(signerKey.PublicKey)
	takerKey, _ := crypto.GenerateKey()
	taker := crypto.PubkeyToAddress(takerKey.PublicKey)

	// 给 taker 转 1 ETH 作 gas（taker 要发 approve/deposit 交易；不转则
	// eth_estimateGas 因余额为 0 报 "Out of gas: gas required exceeds allowance: 0"）
	gasPrice, err := client.SuggestGasPrice(ctx)
	if err != nil {
		t.Fatal(err)
	}
	{
		nonce, err := client.PendingNonceAt(ctx, owner)
		if err != nil {
			t.Fatal(err)
		}
		tx := types.NewTransaction(nonce, taker, new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil), 21000, gasPrice, nil)
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

	e18 := new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)
	supply := new(big.Int).Mul(big.NewInt(1000000), e18)
	btcAddr, btc := deploy(t, client, ownerKey, loadArtifact(t, "MockERC20"), "Bitcoin", "BTC", supply)
	usdtAddr, usdt := deploy(t, client, ownerKey, loadArtifact(t, "MockERC20"), "Tether", "USDT", supply)
	vaultAddr, vault := deploy(t, client, ownerKey, loadArtifact(t, "Vault"))
	feeDistAddr, _ := deploy(t, client, ownerKey, loadArtifact(t, "FeeDistributor"))
	settlementAddr, settlement := deploy(t, client, ownerKey, loadArtifact(t, "Settlement"), vaultAddr, feeDistAddr)
	feedAddr, _ := deploy(t, client, ownerKey, loadArtifact(t, "MockAggregatorV3"), big.NewInt(7582234000000), uint8(8))
	makerVaultAddr, makerVault := deploy(t, client, ownerKey, loadArtifact(t, "MakerVault"), usdtAddr, vaultAddr, btcAddr, feedAddr)
	t.Logf("vault=%s settlement=%s makerVault=%s feed=%s", vaultAddr, settlementAddr, makerVaultAddr, feedAddr)

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

	do(vault, ownerKey, "setSettlement", settlementAddr)
	do(vault, ownerKey, "setLocker", owner, true)
	// 登记金库签名者（ROLE_MARKET_MAKER，从合约读常量，避免硬编码）
	roleMM := call(makerVault, "ROLE_MARKET_MAKER")[0].([32]byte)
	do(makerVault, ownerKey, "setSigner", signer, roleMM, true)
	// owner（存款人）存入 1000 USDT → 金库自动转入交易 Vault
	amt1000 := new(big.Int).Mul(big.NewInt(1000), e18)
	do(usdt, ownerKey, "transfer", taker, amt1000) // 一部分给 taker 备用（下面 taker 也需要 BTC）
	do(usdt, ownerKey, "approve", makerVaultAddr, new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1)))
	do(makerVault, ownerKey, "deposit", amt1000, owner)
	if got := call(vault, "balanceOf", usdtAddr, makerVaultAddr)[0].(*big.Int); got.Cmp(amt1000) != 0 {
		t.Fatalf("makerVault USDT in trading vault = %s, want 1000", got)
	}
	if got := call(makerVault, "balanceOf", owner)[0].(*big.Int); got.Cmp(amt1000) != 0 {
		t.Fatalf("depositor shares = %s, want 1000e18", got)
	}
	// taker 充 1 BTC 到交易 Vault
	do(btc, ownerKey, "transfer", taker, new(big.Int).Mul(big.NewInt(1), e18))
	do(btc, takerKey, "approve", vaultAddr, new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1)))
	do(vault, takerKey, "deposit", btcAddr, new(big.Int).Mul(big.NewInt(1), e18))

	match.SetDomain(chainID, settlementAddr)
	now := time.Now().Unix()
	pair := "BTC/USDT"
	pairTokens := match.PairTokens{Token0: btcAddr.Hex(), Token1: usdtAddr.Hex()}
	price := "75822340000000000000000" // 75822.34e18
	amount := "10000000000000000"      // 0.01e18 BTC

	vaultBuyOrder := &storage.Order{
		OrderID: "vault-buy-1", Trader: makerVaultAddr.Hex(), Pair: pair, Side: "buy",
		Price: price, Amount: amount, Filled: "0", Status: "open", Nonce: 0, CreatedAt: now, ExpiresAt: now + 3600,
	}
	vBuy := match.BuildSignedOrder(vaultBuyOrder, &pairTokens)
	sigV, err := match.SignOrder(signerKey, vBuy)
	if err != nil {
		t.Fatal(err)
	}
	vBuy.Signature = sigV
	// 纯验签必须失败（恢复地址为签名者 EOA ≠ 金库），链上验签必须成功
	if ok, _ := match.VerifySignedOrder(vBuy); ok {
		t.Fatal("pure ecrecover verify of a vault order must be false (signer != vault)")
	}
	if ok, err := match.VerifySignedOrderOnChain(ctx, rpc, settlementAddr.Hex(), vBuy); err != nil || !ok {
		t.Fatalf("on-chain ERC-1271 verify of vault order: ok=%v err=%v", ok, err)
	}
	t.Logf("vault order: pure verify=false, on-chain verify=true (ERC-1271)")

	takerSellOrder := &storage.Order{
		OrderID: "taker-sell-1", Trader: taker.Hex(), Pair: pair, Side: "sell",
		Price: price, Amount: amount, Filled: "0", Status: "open", Nonce: 0, CreatedAt: now, ExpiresAt: now + 3600,
	}
	tSell := match.BuildSignedOrder(takerSellOrder, &pairTokens)
	sigT, err := match.SignOrder(takerKey, tSell)
	if err != nil {
		t.Fatal(err)
	}
	tSell.Signature = sigT

	// 落锁：金库买（锁 USDT）+ taker 卖（锁 BTC）
	if _, tx, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), anvilOwnerKeyHex, vBuy); err != nil {
		t.Fatalf("LockOrder(vault buy): %v", err)
	} else {
		t.Logf("vault buy locked tx=%s", tx)
	}
	// 幂等：同一订单再次落锁不得发交易，直接成功
	if _, tx, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), anvilOwnerKeyHex, vBuy); err != nil {
		t.Fatalf("LockOrder(vault buy) retry: %v", err)
	} else if tx != "" {
		t.Fatalf("idempotent LockOrder must not send a tx, got %s", tx)
	} else {
		t.Logf("LockOrder idempotency verified: retry returned success with no tx")
	}
	if _, tx, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), anvilOwnerKeyHex, tSell); err != nil {
		t.Fatalf("LockOrder(taker sell): %v", err)
	} else {
		t.Logf("taker sell locked tx=%s", tx)
	}

	trade := &storage.Trade{
		TradeID: "vault-trade-1", MakerOrder: tSell, TakerOrder: vBuy,
		TokenIn: btcAddr.Hex(), TokenOut: usdtAddr.Hex(), Amount: amount, Price: price,
	}
	txHash, err := SubmitTrade(ctx, trade, rpc, settlementAddr.Hex(), anvilOwnerKeyHex)
	if err != nil {
		t.Fatalf("SubmitTrade(vault buy): %v", err)
	}
	t.Logf("vault buy settled tx=%s", txHash)

	vaultBal := func(token, user common.Address) *big.Int {
		return call(vault, "balanceOf", token, user)[0].(*big.Int)
	}
	expect := func(name string, got, want *big.Int) {
		if got.Cmp(want) != 0 {
			t.Errorf("%s = %s, want %s", name, got, want)
		}
		t.Logf("assert %s = %s OK", name, got)
	}
	// 手续费 1bp：金库得 0.01 - 0.000001 = 0.009999 BTC；付 758.2234 USDT
	expect("makerVault BTC in trading vault", vaultBal(btcAddr, makerVaultAddr), wei("9999000000000000"))
	expect("makerVault USDT in trading vault", vaultBal(usdtAddr, makerVaultAddr), wei("241776600000000000000"))
	// NAV = 241.7766 + 0.009999×75822.34 = 999.92417766
	expect("makerVault totalAssets (NAV)", call(makerVault, "totalAssets")[0].(*big.Int), wei("999924177660000000000"))
	expect("depositor shares unchanged", call(makerVault, "balanceOf", owner)[0].(*big.Int), amt1000)
	expect("vault nonce", call(settlement, "getCurrentNonce", makerVaultAddr)[0].(*big.Int), big.NewInt(1))
	expect("taker nonce", call(settlement, "getCurrentNonce", taker)[0].(*big.Int), big.NewInt(1))
}

// ---- 回执定论（第二十七轮） ----
//
// lookupReceipt / waitMinedVerdict 对三种链上状态的定论：已上链成功（返回回执）、
// 未知 hash（ErrTxDropped）、nonce 缺口导致滞留 mempool（ErrTxPending）。
// 关键语义：超时后返回的错误必须区分「已 revert」与「未见回执」，提交器据此
// 决定终态失败还是重试。
func TestAnvilTxVerdict(t *testing.T) {
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
	ownerKey, err := crypto.HexToECDSA(anvilOwnerKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	owner := crypto.PubkeyToAddress(ownerKey.PublicKey)

	// 已上链：普通转账 → 回执 status=1
	nonce, err := client.PendingNonceAt(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	gasPrice, err := client.SuggestGasPrice(ctx)
	if err != nil {
		t.Fatal(err)
	}
	recipient := common.HexToAddress("0x000000000000000000000000000000000000dead")
	minedTx := types.NewTransaction(nonce, recipient, big.NewInt(1), 21000, gasPrice, nil)
	signedMined, err := types.SignTx(minedTx, types.LatestSignerForChainID(chainID), ownerKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.SendTransaction(ctx, signedMined); err != nil {
		t.Fatal(err)
	}
	// 先等上链：SendTransaction 只表示进 mempool，立即查回执会在出块前撞上
	// NotFound（anvil 即时出块仍是异步的），被误判为 ErrTxPending。
	if _, err := bind.WaitMined(ctx, client, signedMined); err != nil {
		t.Fatal(err)
	}
	receipt, err := lookupReceipt(ctx, client, signedMined.Hash())
	if err != nil {
		t.Fatalf("lookupReceipt(mined): %v", err)
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		t.Fatalf("mined receipt status = %d, want 1", receipt.Status)
	}
	// waitMinedVerdict 对已上链成功的交易返回 hash、无错误
	if hash, err := waitMinedVerdict(ctx, client, signedMined); err != nil || hash != signedMined.Hash().Hex() {
		t.Fatalf("waitMinedVerdict(mined) = (%q, %v), want (%q, nil)", hash, err, signedMined.Hash().Hex())
	}
	t.Logf("mined tx verdict OK: %s", signedMined.Hash().Hex())

	// 未知 hash：不在链上也不在 mempool → ErrTxDropped
	unknown := common.HexToHash("0x1111111111111111111111111111111111111111111111111111111111111111")
	if _, err := lookupReceipt(ctx, client, unknown); !errors.Is(err, ErrTxDropped) {
		t.Fatalf("lookupReceipt(unknown) err = %v, want ErrTxDropped", err)
	}
	t.Logf("unknown hash verdict OK: ErrTxDropped")

	// 滞留 mempool：nonce 缺口的交易（pending nonce + 1）进队列但永不上链
	pendingKey, _ := crypto.GenerateKey()
	pendingAddr := crypto.PubkeyToAddress(pendingKey.PublicKey)
	fundNonce, err := client.PendingNonceAt(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	fundTx := types.NewTransaction(fundNonce, pendingAddr, new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil), 21000, gasPrice, nil)
	signedFund, err := types.SignTx(fundTx, types.LatestSignerForChainID(chainID), ownerKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.SendTransaction(ctx, signedFund); err != nil {
		t.Fatal(err)
	}
	if _, err := bind.WaitMined(ctx, client, signedFund); err != nil {
		t.Fatal(err)
	}
	pendingNonce, err := client.PendingNonceAt(ctx, pendingAddr)
	if err != nil {
		t.Fatal(err)
	}
	gapTx := types.NewTransaction(pendingNonce+1, recipient, big.NewInt(1), 21000, gasPrice, nil)
	signedGap, err := types.SignTx(gapTx, types.LatestSignerForChainID(chainID), pendingKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.SendTransaction(ctx, signedGap); err != nil {
		t.Fatalf("send gap tx (expected to pool, not mine): %v", err)
	}
	if _, err := lookupReceipt(ctx, client, signedGap.Hash()); !errors.Is(err, ErrTxPending) {
		t.Fatalf("lookupReceipt(gap tx) err = %v, want ErrTxPending", err)
	}
	t.Logf("queued tx verdict OK: ErrTxPending")
	// waitMinedVerdict 在短超时内对滞留交易返回 hash + ErrTxPending（不是裸超时错误）
	shortCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if hash, err := waitMinedVerdict(shortCtx, client, signedGap); !errors.Is(err, ErrTxPending) || hash != signedGap.Hash().Hex() {
		t.Fatalf("waitMinedVerdict(pending) = (%q, %v), want (%q, ErrTxPending)", hash, err, signedGap.Hash().Hex())
	}
	t.Logf("waitMinedVerdict(pending) OK: hash + ErrTxPending")
}
