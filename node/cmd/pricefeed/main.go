package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/P2P-P2P/p2p/node/internal/reward"
)

// 价格与结算服务 CLI：按日去极值再周平均
// 用法1: -input prices.json  从 JSON 读取
// 用法2: -source coingecko -coin ethereum -days 7  从 CoinGecko API 拉取
func main() {
	input := flag.String("input", "", "JSON 文件路径，含 dailyPrices 数组")
	source := flag.String("source", "", "数据源：coingecko（需 -coin）")
	coin := flag.String("coin", "", "CoinGecko 代币 id，如 ethereum、usd-coin")
	days := flag.Int("days", 7, "拉取天数（与 -source 同用）")
	trimPercent := flag.Float64("trim", 5, "日去极值比例，如 5 表示两端各 5%%")
	flag.Parse()

	var dailyPrices [][]float64
	switch {
	case *input != "":
		data, err := os.ReadFile(*input)
		if err != nil {
			fmt.Fprintf(os.Stderr, "读取文件: %v\n", err)
			os.Exit(1)
		}
		var payload struct {
			DailyPrices [][]float64 `json:"dailyPrices"`
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			fmt.Fprintf(os.Stderr, "解析 JSON: %v\n", err)
			os.Exit(1)
		}
		dailyPrices = payload.DailyPrices
	case *source == "coingecko" && *coin != "":
		end := time.Now().UTC()
		start := end.AddDate(0, 0, -(*days))
		fetcher := reward.NewCoinGeckoFetcher()
		var err error
		dailyPrices, err = fetcher.FetchDailyPrices(context.Background(), *coin, start, end)
		if err != nil {
			fmt.Fprintf(os.Stderr, "拉取价格: %v\n", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "用法: pricefeed -input prices.json [-trim 5]")
		fmt.Fprintln(os.Stderr, "  或: pricefeed -source coingecko -coin ethereum -days 7 [-trim 5]")
		fmt.Fprintln(os.Stderr, "prices.json 格式: {\"dailyPrices\": [[日1采样价...], [日2...], ...]} 共7天")
		os.Exit(1)
	}

	avg := reward.WeeklyAveragePrice(dailyPrices, *trimPercent)
	fmt.Printf("周均价（trim %.0f%%）: %.18f\n", *trimPercent, avg)
}
