package config

import (
	"os"

	"gopkg.in/yaml.v3"
)

// Config 节点配置（与 config.example.yaml 对应）
type Config struct {
	Node    NodeConfig    `yaml:"node"`
	Network NetworkConfig `yaml:"network"`
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
	}
}
