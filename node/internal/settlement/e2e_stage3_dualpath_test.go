package settlement

// 阶段 3 块 D1：同单对照 E2E —— 节点路径驱动（本地 anvil，绝不连外网）。
//
// 与前端路径驱动（frontend/scripts/stage3-e2e/driver.ts）使用完全相同
// 的部署顺序、账户（anvil #0/#1/#2）、订单字段与价格：同一 maker 卖单
// （100 TKA @2.0）与 taker 买单（100 TKA、限价 2.5 → 成交价应为 maker
// 价 2.0，价格改善可测），分别经节点引擎撮合 + SubmitTrade（settleTrade
// 单笔入口，owner 提交）与前端撮合 + settleTradesBatch（taker 自提）
// 结算，结果 JSON 由 compare.mjs 逐项对账（成交量/成交价/gas 对半/
// FeeDistributor 99/1 分账）。
//
// 仅当 BIT100_ANVIL_RPC 存在时运行；结果 JSON 写 BIT100_DUALPATH_OUT。
// anvil 需以 --gas-price 1000000000 启动，使两路径 tx.gasprice 同口径。

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
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

const (
	anvilMakerKeyHex = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" // anvil #1
	anvilTakerKeyHex = "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"                        // anvil #2
	anvilDevAddr     = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"                        // anvil #3（仅收款）
	stage3CreatedAt  = int64(1700000000)
	stage3ExpiresAt  = int64(2000000000)
)

type dualPathResult struct {
	Path           string            `json:"path"`
	Addresses      map[string]string `json:"addresses"`
	MakerDigest    string            `json:"makerDigest"`
	TakerDigest    string            `json:"takerDigest"`
	ExecPrice      string            `json:"execPrice"`
	QtyToken0      string            `json:"qtyToken0"`
	QuoteAmount    string            `json:"quoteAmount"`
	SettleTx       string            `json:"settleTx"`
	SettleGasUsed  string            `json:"settleGasUsed"`
	Vault          map[string]string `json:"vault"`
	FeeDistributor map[string]string `json:"feeDistributor"`
	Developer      map[string]string `json:"developer"`
	Filled         map[string]string `json:"filled"`
	Nonces         map[string]string `json:"nonces"`
	GasEvent       map[string]string `json:"gasEvent"`
}

func TestAnvilStage3NodePath(t *testing.T) {
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
	// 链参数由 anvil --chain-id 决定（31337 本地 / 11155111 Sepolia /
	// 84532 Base Sepolia 三套参数各跑一遍，域随链走、其余流程不变）
	t.Logf("dualpath chain id: %s", chainID)

	ownerKey, _ := crypto.HexToECDSA(anvilOwnerKeyHex)
	makerKey, _ := crypto.HexToECDSA(anvilMakerKeyHex)
	takerKey, _ := crypto.HexToECDSA(anvilTakerKeyHex)
	maker := crypto.PubkeyToAddress(makerKey.PublicKey)
	taker := crypto.PubkeyToAddress(takerKey.PublicKey)
	dev := common.HexToAddress(anvilDevAddr)

	e18 := new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)
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
	do(chainConfig, ownerKey, "setQuotePricing", tokenBAddr, new(big.Int).Mul(big.NewInt(2000), e18))
	do(feeDist, ownerKey, "setDeveloperAddress", dev)

	// ---- 资金与 Vault 存款 ----
	amt100 := new(big.Int).Mul(big.NewInt(100), e18)
	amt1000 := new(big.Int).Mul(big.NewInt(1000), e18)
	maxUint := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	do(tokenA, ownerKey, "transfer", maker, amt1000)
	do(tokenB, ownerKey, "transfer", taker, amt1000)
	do(tokenA, makerKey, "approve", vaultAddr, maxUint)
	do(vault, makerKey, "deposit", tokenAAddr, amt100)
	do(tokenB, takerKey, "approve", vaultAddr, maxUint)
	do(vault, takerKey, "deposit", tokenBAddr, amt1000)

	// ---- 订单（固定字段，两路径逐字一致） ----
	match.SetDomain(chainID, settlementAddr)
	pair := "TKA/TKB"
	pairTokens := match.PairTokens{Token0: tokenAAddr.Hex(), Token1: tokenBAddr.Hex()}
	makerOrder := &storage.Order{
		OrderID: "s3-maker-1", Trader: maker.Hex(), Pair: pair, Side: "sell",
		Price: "2000000000000000000", Amount: "100000000000000000000",
		Filled: "0", Status: "open", Nonce: 0, CreatedAt: stage3CreatedAt, ExpiresAt: stage3ExpiresAt,
	}
	sigM, err := match.SignOrder(makerKey, match.BuildSignedOrder(makerOrder, &pairTokens))
	if err != nil {
		t.Fatal(err)
	}
	makerOrder.Signature = sigM
	takerOrder := &storage.Order{
		OrderID: "s3-taker-1", Trader: taker.Hex(), Pair: pair, Side: "buy",
		Price: "2500000000000000000", Amount: "100000000000000000000",
		Filled: "0", Status: "open", Nonce: 0, CreatedAt: stage3CreatedAt, ExpiresAt: stage3ExpiresAt,
	}
	sigT, err := match.SignOrder(takerKey, match.BuildSignedOrder(takerOrder, &pairTokens))
	if err != nil {
		t.Fatal(err)
	}
	takerOrder.Signature = sigT

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

	// ---- 落锁（节点 LockOrder；提交者 owner 代补双边锁，与守护进程同路径） ----
	if _, _, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), anvilOwnerKeyHex, trade.MakerOrder); err != nil {
		t.Fatalf("LockOrder(maker): %v", err)
	}
	if _, _, err := LockOrder(ctx, rpc, vaultAddr.Hex(), settlementAddr.Hex(), anvilOwnerKeyHex, trade.TakerOrder); err != nil {
		t.Fatalf("LockOrder(taker): %v", err)
	}

	// ---- 结算（节点 SubmitTrade → settleTrade 单笔入口） ----
	txHash, err := SubmitTrade(ctx, trade, rpc, settlementAddr.Hex(), anvilOwnerKeyHex)
	if err != nil {
		t.Fatalf("SubmitTrade: %v", err)
	}
	receipt, err := client.TransactionReceipt(ctx, common.HexToHash(txHash))
	if err != nil {
		t.Fatal(err)
	}

	// ---- 结果采集 ----
	makerDigest := matchDigest(t, trade.MakerOrder, chainID, settlementAddr)
	takerDigest := matchDigest(t, trade.TakerOrder, chainID, settlementAddr)
	qty0, err := decimalToInt(trade.Amount)
	if err != nil {
		t.Fatal(err)
	}
	priceWei, err := decimalToInt(trade.Price)
	if err != nil {
		t.Fatal(err)
	}
	gasEvent := map[string]string{}
	gasEvt := settlementArt.ABI.Events["GasCostShared"]
	for _, log := range receipt.Logs {
		if len(log.Topics) == 0 || log.Topics[0] != gasEvt.ID {
			continue
		}
		vals, err := gasEvt.Inputs.Unpack(log.Data)
		if err != nil {
			t.Fatalf("unpack GasCostShared: %v", err)
		}
		// 非索引字段序：gasUsed, gasCostWei, reason, makerToken, makerDeduct,
		// makerShortfall, takerToken, takerDeduct, takerShortfall
		gasEvent = map[string]string{
			"gasUsed":       vals[0].(*big.Int).String(),
			"gasCostWei":    vals[1].(*big.Int).String(),
			"reason":        big.NewInt(int64(vals[2].(uint8))).String(),
			"makerDeduct":   vals[4].(*big.Int).String(),
			"makerShortfall": vals[5].(*big.Int).String(),
			"takerDeduct":   vals[7].(*big.Int).String(),
			"takerShortfall": vals[8].(*big.Int).String(),
		}
	}
	res := dualPathResult{
		Path:        "node",
		Addresses:   map[string]string{"tokenA": tokenAAddr.Hex(), "tokenB": tokenBAddr.Hex(), "vault": vaultAddr.Hex(), "feeDistributor": feeDistAddr.Hex(), "settlement": settlementAddr.Hex()},
		MakerDigest: makerDigest,
		TakerDigest: takerDigest,
		ExecPrice:   priceWei.String(),
		QtyToken0:   qty0.String(),
		QuoteAmount: new(big.Int).Div(new(big.Int).Mul(qty0, priceWei), e18).String(),
		SettleTx:    txHash,
		SettleGasUsed: big.NewInt(int64(receipt.GasUsed)).String(),
		Vault: map[string]string{
			"makerA": call(vault, "balanceOf", tokenAAddr, maker).String(),
			"makerB": call(vault, "balanceOf", tokenBAddr, maker).String(),
			"takerA": call(vault, "balanceOf", tokenAAddr, taker).String(),
			"takerB": call(vault, "balanceOf", tokenBAddr, taker).String(),
		},
		FeeDistributor: map[string]string{
			"a": call(tokenA, "balanceOf", feeDistAddr).String(),
			"b": call(tokenB, "balanceOf", feeDistAddr).String(),
		},
		Developer: map[string]string{
			"a": call(tokenA, "balanceOf", dev).String(),
			"b": call(tokenB, "balanceOf", dev).String(),
		},
		Filled: map[string]string{
			"makerIn":  call(settlement, "orderFilledIn", common.HexToHash(makerDigest)).String(),
			"makerOut": call(settlement, "orderFilledOut", common.HexToHash(makerDigest)).String(),
			"takerIn":  call(settlement, "orderFilledIn", common.HexToHash(takerDigest)).String(),
			"takerOut": call(settlement, "orderFilledOut", common.HexToHash(takerDigest)).String(),
		},
		Nonces: map[string]string{
			"maker": call(settlement, "getCurrentNonce", maker).String(),
			"taker": call(settlement, "getCurrentNonce", taker).String(),
		},
		GasEvent: gasEvent,
	}
	raw, _ := json.MarshalIndent(res, "", "  ")
	t.Logf("dualpath node result:\n%s", raw)
	if out := os.Getenv("BIT100_DUALPATH_OUT"); out != "" {
		if err := os.WriteFile(out, raw, 0o644); err != nil {
			t.Fatalf("write result: %v", err)
		}
	}
}

// matchDigest 计算签名订单摘要（与前端 hashOrderWithDomain 同值）。
func matchDigest(t *testing.T, so *storage.SignedOrder, chainID *big.Int, settlementAddr common.Address) string {
	t.Helper()
	_ = chainID
	_ = settlementAddr // 域已由 SetDomain 设定（与 SignOrder 同一域）
	d, err := match.OrderDigest(so)
	if err != nil {
		t.Fatalf("digest: %v", err)
	}
	return d.Hex()
}
