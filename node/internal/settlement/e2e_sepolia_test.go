package settlement

// Sepolia 测试网端到端验证：使用已部署的合约（forge script Deploy.runWithAmmAndMocks）跑一笔真实结算。
// 仅当环境变量 BIT100_SEPOLIA_RPC 等齐全时运行；默认 go test 不触发。
// 断言口径与 anvil 版基本一致：maker 卖 100 TKA、价 2 TKB/TKA，taker 全额吃单；费率 1bp 双边：
// maker 得 199.98 TKB，taker 得 99.99 TKA，双方 nonce 各 +1；同一成交再次提交必须被链上拒绝。
// 与 anvil 版的差别：手续费先按合约设计自动转 1% 给开发者、99% 留在 FeeDistributor
// （anvil 版未设开发者地址，FD 留存 100%）。开发者地址从 FeeDistributor 合约的
// developerAddress() 读回（第三轮部署时为部署者；第四轮起新 FD 的开发者为 Ren 的钱包
// 0x047df18eF5484945D33fBddB8D58D382597354d9，断言自动跟随）。断言全部采用结算前后
// 增量口径，本测试可重复运行。
// 第五轮起：Settlement 已重部署（新增 setFeeDistributor 并指向新 FD），
// BIT100_SEPOLIA_SETTLEMENT / BIT100_SEPOLIA_FEEDIST 传入新地址即可；新 Settlement 上
// 双方 nonce 从 0 起算，测试按 getCurrentNonce 读数，无需改动。
//
// 必需环境变量：
//   BIT100_SEPOLIA_RPC        Sepolia RPC URL
//   BIT100_SEPOLIA_OWNER_KEY  部署者私钥（合约 owner，持有 Mock 代币，作为结算提交方）
//   BIT100_SEPOLIA_MAKER_KEY  maker 私钥（新账户）
//   BIT100_SEPOLIA_TAKER_KEY  taker 私钥（新账户）
//   BIT100_SEPOLIA_VAULT / BIT100_SEPOLIA_FEEDIST / BIT100_SEPOLIA_SETTLEMENT
//   BIT100_SEPOLIA_TOKENA / BIT100_SEPOLIA_TOKENB
// 可选：BIT100_E2E_CHAIN_ID 期望链 ID（默认 11155111；多链同构验证时传目标链，如 84532）

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"os"
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

func sepKey(t *testing.T, env string) *ecdsa.PrivateKey {
	t.Helper()
	hex := strings.TrimPrefix(os.Getenv(env), "0x")
	if hex == "" {
		t.Skipf("%s not set; skipping sepolia e2e", env)
	}
	key, err := crypto.HexToECDSA(hex)
	if err != nil {
		t.Fatalf("%s: bad key: %v", env, err)
	}
	return key
}

func sepAddr(t *testing.T, env string) common.Address {
	t.Helper()
	v := os.Getenv(env)
	if v == "" {
		t.Skipf("%s not set; skipping sepolia e2e", env)
	}
	return common.HexToAddress(v)
}

func TestSepoliaE2E(t *testing.T) {
	rpc := os.Getenv("BIT100_SEPOLIA_RPC")
	if rpc == "" {
		t.Skip("BIT100_SEPOLIA_RPC not set; skipping sepolia e2e")
	}
	ownerKey := sepKey(t, "BIT100_SEPOLIA_OWNER_KEY")
	makerKey := sepKey(t, "BIT100_SEPOLIA_MAKER_KEY")
	takerKey := sepKey(t, "BIT100_SEPOLIA_TAKER_KEY")
	vaultAddr := sepAddr(t, "BIT100_SEPOLIA_VAULT")
	feeDistAddr := sepAddr(t, "BIT100_SEPOLIA_FEEDIST")
	settlementAddr := sepAddr(t, "BIT100_SEPOLIA_SETTLEMENT")
	tokenAAddr := sepAddr(t, "BIT100_SEPOLIA_TOKENA")
	tokenBAddr := sepAddr(t, "BIT100_SEPOLIA_TOKENB")

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
	// 期望链可由 BIT100_E2E_CHAIN_ID 覆盖（多链同构验证用，如 Base Sepolia 84532）；
	// 未设置时默认 Sepolia 11155111，行为与此前一致。
	expectedChainID := int64(11155111)
	if v := os.Getenv("BIT100_E2E_CHAIN_ID"); v != "" {
		n, err := fmt.Sscanf(v, "%d", &expectedChainID)
		if err != nil || n != 1 {
			t.Fatalf("bad BIT100_E2E_CHAIN_ID %q", v)
		}
	}
	if chainID.Int64() != expectedChainID {
		t.Fatalf("expected chain id %d, got %s", expectedChainID, chainID)
	}

	owner := crypto.PubkeyToAddress(ownerKey.PublicKey)
	maker := crypto.PubkeyToAddress(makerKey.PublicKey)
	taker := crypto.PubkeyToAddress(takerKey.PublicKey)
	t.Logf("owner=%s maker=%s taker=%s", owner, maker, taker)
	t.Logf("vault=%s feeDistributor=%s settlement=%s tokenA=%s tokenB=%s",
		vaultAddr, feeDistAddr, settlementAddr, tokenAAddr, tokenBAddr)

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
		// 公共 RPC 存在副本同步延迟：刚注资的账户在个别后端节点上余额可见性滞后，
		// eth_estimateGas 会误报 "gas required exceeds allowance (0)"。发送前失败可安全重试。
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

	e18 := new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)

	// ---- 给 maker/taker 各转 0.01 ETH 作为 gas（余额不足时） ----
	gasFund := new(big.Int).Div(e18, big.NewInt(100)) // 0.01 ETH
	for _, to := range []common.Address{maker, taker} {
		bal, err := client.BalanceAt(ctx, to, nil)
		if err != nil {
			t.Fatal(err)
		}
		if bal.Cmp(new(big.Int).Div(gasFund, big.NewInt(2))) >= 0 {
			continue
		}
		nonce, err := client.PendingNonceAt(ctx, owner)
		if err != nil {
			t.Fatal(err)
		}
		gasPrice, err := client.SuggestGasPrice(ctx)
		if err != nil {
			t.Fatal(err)
		}
		// 注意：经 publicnode 的 Sepolia 入口 gas 计量非标准——给新地址的普通转账实测
		// 消耗约 204600 gas（水龙头注资 tx 同口径），21000 必定 OOG 失败。
		// 故注资 gas limit 给 500000（gas 价格约 17 wei，成本可忽略），且必须校验回执状态。
		tx := types.NewTransaction(nonce, to, gasFund, 500000, gasPrice, nil)
		signed, err := types.SignTx(tx, types.LatestSignerForChainID(chainID), ownerKey)
		if err != nil {
			t.Fatal(err)
		}
		if err := client.SendTransaction(ctx, signed); err != nil {
			t.Fatal(err)
		}
		receipt, err := bind.WaitMined(ctx, client, signed)
		if err != nil {
			t.Fatal(err)
		}
		if receipt.Status != types.ReceiptStatusSuccessful {
			t.Fatalf("funding %s reverted, tx=%s", to, signed.Hash().Hex())
		}
		t.Logf("funded %s with 0.01 ETH: %s", to, signed.Hash().Hex())
	}

	// ---- 充值到 Vault ----
	amt100 := new(big.Int).Mul(big.NewInt(100), e18)
	amt200 := new(big.Int).Mul(big.NewInt(200), e18)
	amt1000 := new(big.Int).Mul(big.NewInt(1000), e18)
	do(tokenAContract, ownerKey, "transfer", maker, amt1000)
	do(tokenBContract, ownerKey, "transfer", taker, amt1000)
	maxUint := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	do(tokenAContract, makerKey, "approve", vaultAddr, maxUint)
	do(vault, makerKey, "deposit", tokenAAddr, amt100)
	do(tokenBContract, takerKey, "approve", vaultAddr, maxUint)
	do(vault, takerKey, "deposit", tokenBAddr, amt200)

	// ---- 读取双方当前 nonce 并签名 ----
	makerNonce := call(settlement, "getCurrentNonce", maker)[0].(*big.Int).Int64()
	takerNonce := call(settlement, "getCurrentNonce", taker)[0].(*big.Int).Int64()
	t.Logf("nonces before: maker=%d taker=%d", makerNonce, takerNonce)

	match.SetDomain(chainID, settlementAddr)
	now := time.Now().Unix()
	pair := "TKA/TKB"
	pairTokens := match.PairTokens{Token0: tokenAAddr.Hex(), Token1: tokenBAddr.Hex()}

	makerOrder := &storage.Order{
		OrderID: "sepolia-maker-1", Trader: maker.Hex(), Pair: pair, Side: "sell",
		Price: "2000000000000000000", Amount: "100000000000000000000",
		Filled: "0", Status: "open", Nonce: makerNonce, CreatedAt: now, ExpiresAt: now + 3600,
	}
	sigM, err := match.SignOrder(makerKey, match.BuildSignedOrder(makerOrder, &pairTokens))
	if err != nil {
		t.Fatal(err)
	}
	makerOrder.Signature = sigM

	takerOrder := &storage.Order{
		OrderID: "sepolia-taker-1", Trader: taker.Hex(), Pair: pair, Side: "buy",
		Price: "2000000000000000000", Amount: "100000000000000000000",
		Filled: "0", Status: "open", Nonce: takerNonce, CreatedAt: now, ExpiresAt: now + 3600,
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
	t.Logf("matched trade id=%s amount=%s", trade.TradeID, trade.Amount)

	// ---- 结算前快照（断言全部用增量口径，本测试可重复运行） ----
	bal := func(token, user common.Address) *big.Int {
		out := call(vault, "balanceOf", token, user)
		return out[0].(*big.Int)
	}
	wallet := func(contract *bind.BoundContract, user common.Address) *big.Int {
		return call(contract, "balanceOf", user)[0].(*big.Int)
	}
	preMakerTKA, preMakerTKB := bal(tokenAAddr, maker), bal(tokenBAddr, maker)
	preTakerTKA, preTakerTKB := bal(tokenAAddr, taker), bal(tokenBAddr, taker)
	preFDA, preFDB := wallet(tokenAContract, feeDistAddr), wallet(tokenBContract, feeDistAddr)
	// 开发者地址以 FeeDistributor 合约读数为准（第四轮起为 Ren 的钱包，不再是部署者）
	developer := call(feeDist, "developerAddress")[0].(common.Address)
	t.Logf("feeDistributor developer: %s", developer)
	preDevA, preDevB := wallet(tokenAContract, developer), wallet(tokenBContract, developer)

	// ---- 真实上链结算（部署者作为 owner 提交；合约侧验签） ----
	ownerPrivHex := os.Getenv("BIT100_SEPOLIA_OWNER_KEY")
	txHash, err := SubmitTrade(ctx, trade, rpc, settlementAddr.Hex(), ownerPrivHex)
	if err != nil {
		t.Fatalf("SubmitTrade: %v", err)
	}
	t.Logf("settle tx: %s", txHash)

	// ---- 链上状态断言（增量） ----
	// 手续费口径：FeeDistributor.receiveFee 按合约设计先把 developerShareBps（默认
	// 100 = 1%，第四轮起治理可调）自动转给 developerAddress，其余 99% 留在
	// FeeDistributor 分配池。故 FD 增量 = 名义手续费 × 99%，开发者钱包增量 = × 1%。
	// 注意：公共 RPC 为多后端负载均衡，结算 tx 回执可见后，个别 eth_call 仍可能
	// 读到未应用该区块的旧状态（实测出现过单项读数滞后一个区块）。故断言轮询至
	// 全部收敛或超时，最终不一致才判失败。
	check := func() []string {
		var bad []string
		eq := func(name string, got, want *big.Int) {
			if got.Cmp(want) != 0 {
				bad = append(bad, fmt.Sprintf("%s = %s, want %s", name, got, want))
			}
		}
		delta := func(name string, got, base, d *big.Int) {
			eq(name, got, new(big.Int).Add(base, d))
		}
		delta("maker TKA in vault", bal(tokenAAddr, maker), preMakerTKA, wei("-100000000000000000000"))
		delta("maker TKB in vault", bal(tokenBAddr, maker), preMakerTKB, wei("199980000000000000000"))
		delta("taker TKB in vault", bal(tokenBAddr, taker), preTakerTKB, wei("-200000000000000000000"))
		delta("taker TKA in vault", bal(tokenAAddr, taker), preTakerTKA, wei("99990000000000000000"))
		delta("feeDistributor TKA", wallet(tokenAContract, feeDistAddr), preFDA, wei("9900000000000000"))
		delta("feeDistributor TKB", wallet(tokenBContract, feeDistAddr), preFDB, wei("19800000000000000"))
		delta("developer TKA cut", wallet(tokenAContract, developer), preDevA, wei("100000000000000"))
		delta("developer TKB cut", wallet(tokenBContract, developer), preDevB, wei("200000000000000"))
		eq("maker nonce", call(settlement, "getCurrentNonce", maker)[0].(*big.Int), big.NewInt(makerNonce+1))
		eq("taker nonce", call(settlement, "getCurrentNonce", taker)[0].(*big.Int), big.NewInt(takerNonce+1))
		return bad
	}
	var bad []string
	for round := 1; round <= 15; round++ {
		bad = check()
		if len(bad) == 0 {
			t.Logf("all 10 assertions converged OK (round %d)", round)
			break
		}
		t.Logf("assert round %d: %d mismatch(es), waiting for RPC propagation: %v", round, len(bad), bad)
		time.Sleep(10 * time.Second)
	}
	for _, b := range bad {
		t.Error(b)
	}

	// ---- 重放：同一成交再次提交必须失败 ----
	if _, err := SubmitTrade(ctx, trade, rpc, settlementAddr.Hex(), ownerPrivHex); err == nil {
		t.Error("replay of the same trade should have failed on-chain")
	} else {
		t.Logf("replay correctly rejected: %v", err)
	}
}
