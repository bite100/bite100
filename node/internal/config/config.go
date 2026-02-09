package config

import (
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config 节点配置（与 config.example.yaml 对应）
type Config struct {
	Node    NodeConfig    `yaml:"node"`
	Network NetworkConfig `yaml:"network"`
	Storage StorageConfig `yaml:"storage"`
	Chain   ChainConfig   `yaml:"chain"`
	Match   MatchConfig   `yaml:"match"`
	Relay   RelayConfig   `yaml:"relay"`
	Metrics MetricsConfig `yaml:"metrics"`
	API     APIConfig     `yaml:"api"`
}

// APIConfig HTTP API（Phase 3.5 前端：订单簿、下单/撤单、成交）
type APIConfig struct {
	Listen                   string `yaml:"listen"`                       // 如 ":8080"，空则不开 API
	RateLimitOrdersPerMinute uint64 `yaml:"rate_limit_orders_per_minute"` // 每 IP 每分钟下单上限，0=不限制（Spam 防护）
}

// RelayConfig 中继节点限流与抗 Sybil（Phase 3.3）
type RelayConfig struct {
	RateLimitBytesPerSecPerPeer uint64 `yaml:"rate_limit_bytes_per_sec_per_peer"` // 每 peer 每秒字节上限，0=不限制
	RateLimitMsgsPerSecPerPeer  uint64 `yaml:"rate_limit_msgs_per_sec_per_peer"`  // 每 peer 每秒消息数上限，0=不限制
}

// MatchConfig 撮合节点：交易对与链上代币（Phase 3.2）
type MatchConfig struct {
	Pairs map[string]PairTokens `yaml:"pairs"` // pair -> token0(base), token1(quote)
}

// PairTokens 交易对对应的链上代币地址
type PairTokens struct {
	Token0 string `yaml:"token0"`
	Token1 string `yaml:"token1"`
}

// MetricsConfig 贡献指标与证明
type MetricsConfig struct {
	ProofPeriodDays int    `yaml:"proof_period_days"` // 证明周期（天），默认 7
	ProofOutputDir  string `yaml:"proof_output_dir"`   // 证明落盘目录，默认 data_dir/proofs
}

// StorageConfig 仅存储节点
// 数据保留统一两周；retention_months<=0 表示两周（14 天），>0 表示月数（兼容旧配置）
type StorageConfig struct {
	RetentionMonths int `yaml:"retention_months"` // 保留：0 或未填=两周（14天），>0=月数
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
	Type         string   `yaml:"type"`          // storage | relay | match
	DataDir      string   `yaml:"data_dir"`      // 数据目录
	Listen       []string `yaml:"listen"`        // 监听地址，如 /ip4/0.0.0.0/tcp/4001
	RewardWallet string   `yaml:"reward_wallet"` // 领奖地址（可选）；可由 env REWARD_WALLET 覆盖；或通过 -reward-wallet 传入
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
	// retention_months <= 0 表示统一两周（14 天）；>0 表示保留月数
	if c.Storage.RetentionMonths < 0 {
		c.Storage.RetentionMonths = 0
	}
	if c.Metrics.ProofPeriodDays <= 0 {
		c.Metrics.ProofPeriodDays = 7
	}
	if c.Metrics.ProofOutputDir == "" {
		c.Metrics.ProofOutputDir = c.Node.DataDir + "/proofs"
	}
	if w := os.Getenv("REWARD_WALLET"); w != "" {
		c.Node.RewardWallet = strings.TrimSpace(w)
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
		Storage: StorageConfig{RetentionMonths: 0}, // 0 = 两周
		Match:   MatchConfig{Pairs: map[string]PairTokens{}},
		Relay:   RelayConfig{}, // 0 = 不限流
		Metrics: MetricsConfig{ProofPeriodDays: 7, ProofOutputDir: "./data/proofs"},
	}
}
