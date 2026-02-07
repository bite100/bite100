package reward

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// PriceFetcher 从外部数据源拉取代币价格，返回 [day][sample] 供周均价计算
type PriceFetcher interface {
	FetchDailyPrices(ctx context.Context, tokenIdentifier string, startDate, endDate time.Time) ([][]float64, error)
}

// CoinGeckoFetcher 使用 CoinGecko 公开 API 拉取历史价格（按日分组）
// tokenIdentifier 为 coingecko 的 id，如 "ethereum"、"usd-coin"；或 "chain:address" 时需用 coin list 解析
// 文档: https://www.coingecko.com/en/api/documentation
type CoinGeckoFetcher struct {
	BaseURL string
	Client  *http.Client
}

func NewCoinGeckoFetcher() *CoinGeckoFetcher {
	return &CoinGeckoFetcher{
		BaseURL: "https://api.coingecko.com/api/v3",
		Client:  &http.Client{Timeout: 30 * time.Second},
	}
}

// FetchDailyPrices 拉取 startDate~endDate 期间每日多个采样价，返回 [day][sample]
// 使用 market_chart 接口，days 按 endDate-startDate 计算，再按 UTC 日分组
func (f *CoinGeckoFetcher) FetchDailyPrices(ctx context.Context, coinID string, startDate, endDate time.Time) ([][]float64, error) {
	days := int(endDate.Sub(startDate).Hours()/24) + 1
	if days < 1 {
		days = 1
	}
	if days > 90 {
		days = 90 // API 限制
	}
	u := fmt.Sprintf("%s/coins/%s/market_chart?vs_currency=usd&days=%d", f.BaseURL, url.PathEscape(coinID), days)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := f.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("coingecko %s: %s", resp.Status, string(body))
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return parseCoinGeckoMarketChart(body, startDate, endDate)
}

// coingeckoMarketChart 对应 API 返回的 prices 数组: [[timestamp_ms, price], ...]
type coingeckoMarketChart struct {
	Prices [][]float64 `json:"prices"`
}

func parseCoinGeckoMarketChart(body []byte, start, end time.Time) ([][]float64, error) {
	var data coingeckoMarketChart
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, fmt.Errorf("parse coingecko: %w", err)
	}
	startUTC := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, time.UTC)
	endUTC := time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, time.UTC)
	dayCount := int(endUTC.Sub(startUTC).Hours()/24) + 1
	if dayCount <= 0 {
		dayCount = 1
	}
	daily := make([][]float64, dayCount)
	for _, p := range data.Prices {
		if len(p) < 2 {
			continue
		}
		ts := int64(p[0])
		price := p[1]
		t := time.Unix(ts/1000, 0).UTC()
		d := int(t.Sub(startUTC).Hours() / 24)
		if d < 0 || d >= dayCount {
			continue
		}
		daily[d] = append(daily[d], price)
	}
	return daily, nil
}

// StaticPriceFetcher 用于测试或手动输入：直接使用预定义的每日价格
type StaticPriceFetcher struct {
	DailyPrices [][]float64 // [day][sample]
}

func (s *StaticPriceFetcher) FetchDailyPrices(_ context.Context, _ string, _, _ time.Time) ([][]float64, error) {
	return s.DailyPrices, nil
}

// ComputeWeeklyAverage 按文档规则：日去极值 5%，再周平均
func ComputeWeeklyAverage(dailyPrices [][]float64) float64 {
	return WeeklyAveragePrice(dailyPrices, 5)
}

// FormatPeriod 格式化为 period 字符串，如 2025-02-01_2025-02-08
func FormatPeriod(start, end time.Time) string {
	return start.Format("2006-01-02") + "_" + end.Format("2006-01-02")
}

// ParsePrice 从字符串解析价格
func ParsePrice(s string) (float64, error) {
	return strconv.ParseFloat(strings.TrimSpace(s), 64)
}
