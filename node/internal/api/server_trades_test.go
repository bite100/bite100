package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// 第二十九轮：GET /api/trades 的行为契约——
//  1. 无成交时返回 JSON []，永不返回 null；
//  2. 支持 since（unix 秒）过滤；缺省仍为最近 7 天（旧行为）；
//  3. since 非法（非整数/负数）返回 400。
func TestHandleTradesEmptyArrayAndSince(t *testing.T) {
	db, err := storage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := &Server{Store: db}

	get := func(url string) (int, string) {
		req := httptest.NewRequest(http.MethodGet, url, nil)
		rec := httptest.NewRecorder()
		s.handleTrades(rec, req)
		return rec.Code, strings.TrimSpace(rec.Body.String())
	}

	// 1. 空库 → []
	code, body := get("/api/trades")
	if code != http.StatusOK || body != "[]" {
		t.Fatalf("空结果: code=%d body=%q, want 200 []", code, body)
	}

	// 落两笔不同时间的成交（时间以当前为锚，避免默认 7 天窗口干扰）
	now := time.Now().Unix()
	old := &storage.Trade{TradeID: "old1", Pair: "TKA/TKB", MakerOrderID: "m1", TakerOrderID: "t1", Timestamp: now - 3600}
	recent := &storage.Trade{TradeID: "new1", Pair: "TKA/TKB", MakerOrderID: "m2", TakerOrderID: "t2", Timestamp: now - 60}
	if err := db.InsertTrade(old); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertTrade(recent); err != nil {
		t.Fatal(err)
	}

	// 2a. 缺省窗口（最近 7 天）两笔都在
	code, body = get("/api/trades")
	var list []map[string]interface{}
	if code != http.StatusOK || json.Unmarshal([]byte(body), &list) != nil || len(list) != 2 {
		t.Fatalf("缺省窗口: code=%d body=%q, want 2 笔", code, body)
	}
	// 2b. since 只保留较新一笔
	code, body = get("/api/trades?since=" + strconv.FormatInt(now-1800, 10))
	if code != http.StatusOK || json.Unmarshal([]byte(body), &list) != nil || len(list) != 1 {
		t.Fatalf("since 过滤: code=%d body=%q, want 1 笔", code, body)
	}
	// 2c. since 在两笔之后 → 仍是 [] 而非 null
	code, body = get("/api/trades?since=" + strconv.FormatInt(now+3600, 10))
	if code != http.StatusOK || body != "[]" {
		t.Fatalf("since 之后无成交: code=%d body=%q, want 200 []", code, body)
	}
	// 3. 非法 since → 400
	if code, _ := get("/api/trades?since=abc"); code != http.StatusBadRequest {
		t.Fatalf("since=abc: code=%d, want 400", code)
	}
	if code, _ := get("/api/trades?since=-5"); code != http.StatusBadRequest {
		t.Fatalf("since=-5: code=%d, want 400", code)
	}
}
