package metrics

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
)

// ProofMetrics 贡献证明中的指标
type ProofMetrics struct {
	Uptime         float64 `json:"uptime"`          // [0,1] 周期内在线比例
	StorageUsedGB  float64 `json:"storageUsedGB,omitempty"`
	StorageTotalGB float64 `json:"storageTotalGB,omitempty"`
	BytesRelayed   uint64  `json:"bytesRelayed,omitempty"`
}

// ContributionProof 贡献证明（与 Phase2 设计文档一致）
type ContributionProof struct {
	NodeID    string       `json:"nodeId"`
	NodeType  string       `json:"nodeType"`
	Period    string       `json:"period"`
	Metrics   ProofMetrics `json:"metrics"`
	Signature string       `json:"signature"`
	Timestamp int64        `json:"timestamp"`
}

// GenerateProof 生成带签名的贡献证明；privKey 为节点私钥（可从 host.Peerstore().PrivKey(host.ID()) 获取）
func GenerateProof(
	nodeID peer.ID,
	nodeType string,
	period string,
	uptimeFraction float64,
	storageUsedGB, storageTotalGB float64,
	bytesRelayed uint64,
	privKey crypto.PrivKey,
) (*ContributionProof, error) {
	now := time.Now().Unix()
	m := ProofMetrics{Uptime: uptimeFraction}
	if nodeType == "storage" {
		m.StorageUsedGB = storageUsedGB
		m.StorageTotalGB = storageTotalGB
	}
	if nodeType == "relay" {
		m.BytesRelayed = bytesRelayed
	}
	payload := map[string]interface{}{
		"period":  period,
		"metrics": m,
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	sig, err := privKey.Sign(payloadBytes)
	if err != nil {
		return nil, fmt.Errorf("签名: %w", err)
	}
	return &ContributionProof{
		NodeID:    nodeID.String(),
		NodeType:  nodeType,
		Period:    period,
		Metrics:   m,
		Signature: "0x" + hex.EncodeToString(sig),
		Timestamp: now,
	}, nil
}

// PeriodRange 计算周期字符串，如 "2025-02-01_2025-02-07"（上周）
func PeriodRange(periodDays int) string {
	now := time.Now().UTC()
	end := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	start := end.AddDate(0, 0, -periodDays)
	return start.Format("2006-01-02") + "_" + end.Format("2006-01-02")
}

// PeriodSeconds 周期总秒数
func PeriodSeconds(periodDays int) int64 {
	return int64(periodDays) * 24 * 3600
}

// PeriodEndTime 解析 period 字符串（如 "2025-02-01_2025-02-08"）得到周期结束时刻（end 日 00:00 UTC）
func PeriodEndTime(periodStr string) (time.Time, error) {
	parts := strings.Split(periodStr, "_")
	if len(parts) != 2 {
		return time.Time{}, fmt.Errorf("无效 period: %s", periodStr)
	}
	t, err := time.ParseInLocation("2006-01-02", parts[1], time.UTC)
	if err != nil {
		return time.Time{}, err
	}
	return t, nil
}

// ProofFileExists 判断 outputDir 下是否已有该周期的证明文件
func ProofFileExists(outputDir, periodStr string) bool {
	name := "proof_" + periodStr + ".json"
	path := filepath.Join(outputDir, name)
	_, err := os.Stat(path)
	return err == nil
}

// WriteProofToFile 将证明写入 outputDir，文件名含周期
func WriteProofToFile(proof *ContributionProof, outputDir string) (string, error) {
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return "", err
	}
	name := "proof_" + proof.Period + ".json"
	path := filepath.Join(outputDir, name)
	data, err := json.MarshalIndent(proof, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		return "", err
	}
	log.Printf("[贡献证明] 已写入 %s", path)
	return path, nil
}
