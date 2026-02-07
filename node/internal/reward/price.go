// Package reward：结算价格计算（按日去极值再周平均）
package reward

import "sort"

const defaultTrimPercent = 5 // 去掉最高、最低各 5%

// DailyTrimmedMean 对单日采样价去掉最高 trimPercent%、最低 trimPercent% 后取算术平均。
// prices 为当日各时点采样价；trimPercent 如 5 表示两端各 5%。
// 若样本太少无法 trim 则退回全部样本的算术平均。
func DailyTrimmedMean(prices []float64, trimPercent float64) float64 {
	if len(prices) == 0 {
		return 0
	}
	if trimPercent <= 0 || trimPercent >= 50 {
		return mean(prices)
	}
	sorted := make([]float64, len(prices))
	copy(sorted, prices)
	sort.Float64s(sorted)
	n := len(sorted)
	drop := int(float64(n) * trimPercent / 100)
	if drop*2 >= n {
		return mean(prices)
	}
	trimmed := sorted[drop : n-drop]
	return mean(trimmed)
}

// WeeklyAveragePrice 按日去极值再周平均：每日先做 DailyTrimmedMean(trimPercent)，再对 7 个日均价取算术平均。
// dailyPrices 长度为 7，对应一周 7 天；每天为当日多个采样价。
func WeeklyAveragePrice(dailyPrices [][]float64, trimPercent float64) float64 {
	if len(dailyPrices) == 0 {
		return 0
	}
	var sum float64
	var count int
	for _, day := range dailyPrices {
		if len(day) == 0 {
			continue
		}
		sum += DailyTrimmedMean(day, trimPercent)
		count++
	}
	if count == 0 {
		return 0
	}
	return sum / float64(count)
}

func mean(x []float64) float64 {
	if len(x) == 0 {
		return 0
	}
	var s float64
	for _, v := range x {
		s += v
	}
	return s / float64(len(x))
}
