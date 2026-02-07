package config

import (
	"os"

	"gopkg.in/yaml.v3"
)

// Config 节点配置（与 config.example.yaml 对应）
type Config struct {
	Node    NodeConfig    `yaml:"node"`
	Network NetworkConfig `yaml:"network"`
	Storage StorageConfig `yaml:"storage"`
	Chain   ChainConfig   `yaml:"chain"`
	Metrics MetricsConfig `yaml:"metrics"`
}

// MetricsConfig 贡献指标与证明
type MetricsConfig struct {
	ProofPeriodDays int    `yaml:"proof_period_days"` // 证明周期（天），默认 7
	ProofOutputDir  string `yaml:"proof_output_dir"`   // 证明落盘目录，默认 data_dir/proofs
}

// StorageConfig 仅存储节点
// 电脑端节点填 retention_months: 6，手机端节点填 1；超期数据删除，手机端需更久数据时向电脑端节点拉取
type StorageConfig struct {
	RetentionMonths int `yaml:"retention_months"` // 本节点保留月数：电脑端 6、手机端 1，默认 6
}

// ChainConfig 链 RPC（可选，用于拉取历史成交）
type ChainConfig struct {
	RPCURL   string `yaml:"rpc_url"`
	ChainID  int64  `yaml:"chain_id"`
	AMMPool  string `yaml:"amm_pool"`  // AMMPool 合约地址
	Token0   string `yaml:"token0"`    // token0 地址（用于 pair 标识）
	Token1   string `yaml:"token1"`    // token1 地址
}

type NodeConfig struct {
	Type    string   `yaml:"type"`     // storage | relay
	DataDir string   `yaml:"data_dir"` // 数据目录
	Listen  []string `yaml:"listen"`   // 监听地址，如 /ip4/0.0.0.0/tcp/4001
}

type NetworkConfig struct {
	Bootstrap []string `yaml:"bootstrap"` // Bootstrap 节点 multiaddr
	Topics    []string `yaml:"topics"`    // 订阅的 GossipSub topic
}

// Load 从 path 加载 YAML；若文件不存在返回默认配置
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Default(), nil
		}
		return nil, err
	}
	var c Config
	if err := yaml.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	// 默认值
	if len(c.Node.Listen) == 0 {
		c.Node.Listen = []string{"/ip4/0.0.0.0/tcp/4001"}
	}
	if c.Node.DataDir == "" {
		c.Node.DataDir = "./data"
	}
	if c.Storage.RetentionMonths <= 0 {
		c.Storage.RetentionMonths = 6
	}
	if c.Metrics.ProofPeriodDays <= 0 {
		c.Metrics.ProofPeriodDays = 7
	}
	if c.Metrics.ProofOutputDir == "" {
		c.Metrics.ProofOutputDir = c.Node.DataDir + "/proofs"
	}
	return &c, nil
}

func Default() *Config {
	return &Config{
		Node: NodeConfig{
			Type:    "relay",
			DataDir: "./data",
			Listen:  []string{"/ip4/0.0.0.0/tcp/4001"},
		},
		Network: NetworkConfig{
			Bootstrap: []string{},
			Topics:    []string{"/p2p-exchange/sync/trades", "/p2p-exchange/sync/orderbook"},
		},
		Storage: StorageConfig{RetentionMonths: 6},
		Metrics: MetricsConfig{ProofPeriodDays: 7, ProofOutputDir: "./data/proofs"},
	}
}
