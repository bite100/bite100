package match

import "time"

// EpochDurationSec 默认 Epoch 时长（秒），用于批量撮合与批量结算
const EpochDurationSec int64 = 30

// EpochID 根据时间戳计算 Epoch ID（ deterministic，多节点可复现）
// 用于将成交按时间窗口分组，供 relayer 批量调用 settleTradesBatch
func EpochID(unixSec int64, durationSec int64) int64 {
	if durationSec <= 0 {
		durationSec = EpochDurationSec
	}
	return unixSec / durationSec
}

// CurrentEpochID 返回当前时间所在的 Epoch ID
func CurrentEpochID(durationSec int64) int64 {
	return EpochID(time.Now().Unix(), durationSec)
}
