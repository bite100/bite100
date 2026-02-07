package reward

import (
	"math"
	"testing"
)

func TestDailyTrimmedMean(t *testing.T) {
	// 20 个点，去掉 5% 两端 = 各去 1 个，剩 18 个
	prices := []float64{
		1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
		11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
	}
	got := DailyTrimmedMean(prices, 5)
	// 去掉 1 和 20，剩余 2..19，平均 = (2+19)*18/2/18 = 10.5
	want := 10.5
	if math.Abs(got-want) > 1e-9 {
		t.Errorf("DailyTrimmedMean(5%%) = %v, want %v", got, want)
	}
}

func TestDailyTrimmedMean_NoTrim(t *testing.T) {
	prices := []float64{10, 20, 30}
	got := DailyTrimmedMean(prices, 5)
	// 3*5%=0.15 -> drop 0，不去掉
	want := 20.0
	if math.Abs(got-want) > 1e-9 {
		t.Errorf("DailyTrimmedMean(3 samples) = %v, want %v", got, want)
	}
}

func TestWeeklyAveragePrice(t *testing.T) {
	// 7 天，每天 20 个采样；每天都是 1..20，日均(去 5%)=10.5
	var daily [][]float64
	for day := 0; day < 7; day++ {
		dayPrices := make([]float64, 20)
		for i := range dayPrices {
			dayPrices[i] = float64(i + 1)
		}
		daily = append(daily, dayPrices)
	}
	got := WeeklyAveragePrice(daily, 5)
	want := 10.5
	if math.Abs(got-want) > 1e-9 {
		t.Errorf("WeeklyAveragePrice = %v, want %v", got, want)
	}
}

func TestWeeklyAveragePrice_WithOutliers(t *testing.T) {
	// 某天有极端高/低价，去 5% 后应拉回
	// 日1: 100 个点，98 个是 10，2 个是 1000、0.001 -> 去 1% 两端约 1 个，实际 5% 去 5 个，会去掉 0.001 和若干 10 与 1000
	pricesNormal := make([]float64, 98)
	for i := range pricesNormal {
		pricesNormal[i] = 10
	}
	dayWithOutliers := []float64{0.001, 1000}
	dayWithOutliers = append(dayWithOutliers, pricesNormal...) // 0.001, 1000, 10*98
	// 排序后 0.001, 10*98, 1000；5% 共 5 个，两端各 2～3 个，会去掉 0.001 和 1000 及几个 10
	got := DailyTrimmedMean(dayWithOutliers, 5)
	// 应接近 10
	if got < 9 || got > 11 {
		t.Errorf("DailyTrimmedMean with outliers = %v, expect ~10", got)
	}
}
