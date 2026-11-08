package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"

	"github.com/P2P-P2P/p2p/node/internal/match"
	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// 市价单 API 预检测试（第十七轮，docs/market-orders.md §2.1）：
// 空盘口同步拒绝、盘口有对手盘放行、非法 execType 拒绝。

var marketPairTokens = map[string]match.PairTokens{
	"TKA/TKB": {Token0: "0x1111111111111111111111111111111111111111", Token1: "0x2222222222222222222222222222222222222222"},
}

func signedMarketOrder(t *testing.T, execType string) *storage.Order {
	t.Helper()
	key, err := crypto.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	addr := crypto.PubkeyToAddress(key.PublicKey)
	now := time.Now().Unix()
	o := &storage.Order{
		OrderID:   "mkt_test_1",
		Trader:    addr.Hex(),
		Pair:      "TKA/TKB",
		Side:      "buy",
		Price:     "2000000000000000000", // 保护价 2e18 定点
		Amount:    "500000000000000000",
		CreatedAt: now,
		ExpiresAt: now + 86400,
		Nonce:     1,
		ExecType:  execType,
	}
	pt := marketPairTokens["TKA/TKB"]
	sig, err := match.SignOrder(key, match.BuildSignedOrder(o, &pt))
	if err != nil {
		t.Fatal(err)
	}
	o.Signature = sig
	return o
}

func postOrder(t *testing.T, s *Server, o *storage.Order) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/order", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.handlePostOrder(rec, req)
	return rec
}

func newMarketTestServer(engine *match.Engine) *Server {
	return &Server{
		MatchEngine: engine,
		Publish:     func(topic string, data []byte) error { return nil },
	}
}

func TestPostOrder_MarketEmptyBookRejected(t *testing.T) {
	engine := match.NewEngine(marketPairTokens)
	s := newMarketTestServer(engine)
	rec := postOrder(t, s, signedMarketOrder(t, storage.ExecTypeMarket))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for market order on empty book, got %d (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "market order rejected") {
		t.Errorf("expected clear rejection message, got %q", rec.Body.String())
	}
}

func TestPostOrder_MarketWithLiquidityAccepted(t *testing.T) {
	engine := match.NewEngine(marketPairTokens)
	engine.EnsurePair("TKA/TKB")
	resting := &storage.Order{
		OrderID: "ask1", Trader: "0xmaker", Pair: "TKA/TKB", Side: "sell",
		Price: "2000000000000000000", Amount: "1000000000000000000",
		Filled: "0", Status: "open", CreatedAt: time.Now().Unix(),
	}
	if !engine.AddOrder(resting) {
		t.Fatal("AddOrder resting ask failed")
	}
	s := newMarketTestServer(engine)
	rec := postOrder(t, s, signedMarketOrder(t, storage.ExecTypeMarket))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for market order with opposite liquidity, got %d (%s)", rec.Code, rec.Body.String())
	}
}

func TestPostOrder_InvalidExecTypeRejected(t *testing.T) {
	engine := match.NewEngine(marketPairTokens)
	s := newMarketTestServer(engine)
	rec := postOrder(t, s, signedMarketOrder(t, "fok"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid execType, got %d (%s)", rec.Code, rec.Body.String())
	}
}

// TestPostOrder_InvalidSideRejected 阶段 3 fail-closed：未知 side 必须在接单
// 层被拒（400 invalid side）。用例中的签名是对 buy 口径签出的——若接单层
// 不先判 side，未知值会绕过方向语义冒充卖盘入簿（引擎非 buy 即卖盘口径）。
func TestPostOrder_InvalidSideRejected(t *testing.T) {
	engine := match.NewEngine(marketPairTokens)
	s := newMarketTestServer(engine)
	o := signedMarketOrder(t, storage.ExecTypeLimit)
	o.Side = "hold"
	rec := postOrder(t, s, o)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid side, got %d (%s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid side") {
		t.Errorf("expected invalid side message, got %q", rec.Body.String())
	}
}

func TestPostOrder_LimitUnaffectedByPrecheck(t *testing.T) {
	engine := match.NewEngine(marketPairTokens)
	s := newMarketTestServer(engine)
	// 限价单在空盘口也应正常挂单（不走市价预检）
	rec := postOrder(t, s, signedMarketOrder(t, storage.ExecTypeLimit))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for limit order on empty book, got %d (%s)", rec.Code, rec.Body.String())
	}
}
