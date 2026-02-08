package relay

import (
	"math"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
)

// ReputationScore 计算节点的信誉分数
// 基于转发量、违规次数、在线时长等因素
// 返回值范围：0-10000（10000 表示最高信誉）
func ReputationScore(stats *PeerStats, activeDuration time.Duration) uint64 {
	if stats == nil {
		return 0
	}

	// 基础分数：基于转发量（归一化到 0-5000）
	// 假设 1TB 转发量 = 5000 分
	const maxBytesForScore = 1e12 // 1TB
	bytesScore := float64(stats.BytesRelayed) / maxBytesForScore * 5000
	if bytesScore > 5000 {
		bytesScore = 5000
	}

	// 违规惩罚：每次违规扣 500 分，最低 0 分
	violationPenalty := float64(stats.Violations) * 500
	baseScore := bytesScore - violationPenalty
	if baseScore < 0 {
		baseScore = 0
	}

	// 在线时长奖励：活跃时长越长，奖励越高（最多 3000 分）
	// 假设 30 天活跃 = 3000 分
	const maxActiveDays = 30.0
	activeDays := activeDuration.Hours() / 24
	uptimeScore := (activeDays / maxActiveDays) * 3000
	if uptimeScore > 3000 {
		uptimeScore = 3000
	}

	// 转发量/违规比例奖励：转发量远大于违规次数时给予奖励（最多 2000 分）
	ratioScore := float64(0)
	if stats.Violations == 0 && stats.BytesRelayed > 0 {
		ratioScore = 2000 // 无违规且有转发量，给予满分
	} else if stats.Violations > 0 {
		ratio := float64(stats.BytesRelayed) / float64(stats.Violations)
		// 转发量是违规次数的 1000 倍以上时，给予 2000 分
		if ratio >= 1000 {
			ratioScore = 2000
		} else {
			ratioScore = (ratio / 1000) * 2000
		}
	}

	totalScore := baseScore + uptimeScore + ratioScore
	if totalScore > 10000 {
		totalScore = 10000
	}

	return uint64(math.Round(totalScore))
}

// CalculateReputationForPeer 为指定 peer 计算信誉分数
func (r *Reputation) CalculateReputationForPeer(id peer.ID, activeDuration time.Duration) uint64 {
	r.mu.RLock()
	defer r.mu.RUnlock()

	stats := r.peer[id]
	if stats == nil {
		return 0
	}

	return ReputationScore(stats, activeDuration)
}

// GetHighReputationPeers 返回高信誉节点列表（信誉分数 >= threshold）
func (r *Reputation) GetHighReputationPeers(threshold uint64, activeDuration time.Duration) map[peer.ID]uint64 {
	r.mu.RLock()
	defer r.mu.RUnlock()

	result := make(map[peer.ID]uint64)
	for id, stats := range r.peer {
		score := ReputationScore(stats, activeDuration)
		if score >= threshold {
			result[id] = score
		}
	}

	return result
}
