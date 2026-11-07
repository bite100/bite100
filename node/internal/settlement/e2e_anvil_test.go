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

	// ---- 真实上链结算（owner 作为结算方提交；合约侧验签） ----
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

	// ---- 重放：同一成交再次提交必须失败 ----
	if _, err := SubmitTrade(ctx, trade, rpc, settlementAddr.Hex(), anvilOwnerKeyHex); err == nil {
		t.Error("replay of the same trade should have failed on-chain")
	} else {
		t.Logf("replay correctly rejected: %v", err)
	}
}
