package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/big"
	"os"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/libp2p/go-libp2p/core/peer"

	"github.com/P2P-P2P/p2p/node/internal/config"
	"github.com/P2P-P2P/p2p/node/internal/p2p"
	"github.com/P2P-P2P/p2p/node/internal/relay"
)

// NodeReputationData 节点信誉数据（从多个中继节点收集）
type NodeReputationData struct {
	PeerID        string
	Address       string
	BytesRelayed  uint64
	Violations    uint64
	ActiveDays    float64
	ReputationScore uint64
}

func main() {
	var (
		configPath     = flag.String("config", "config.yaml", "配置文件路径")
		rpcURL         = flag.String("rpc", "", "RPC URL（必需）")
		contractAddr   = flag.String("contract", "", "ContributorReward 合约地址（必需）")
		privateKeyHex  = flag.String("key", "", "私钥（用于签名交易，必需）")
		reputationFile = flag.String("reputation", "reputation.json", "信誉数据 JSON 文件路径")
		dryRun         = flag.Bool("dry-run", false, "仅打印，不实际提交")
	)
	flag.Parse()

	if *rpcURL == "" || *contractAddr == "" || *privateKeyHex == "" {
		log.Fatal("需要提供 -rpc, -contract, -key 参数")
	}

	// 加载配置
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}

	// 读取信誉数据
	reputationData, err := loadReputationData(*reputationFile)
	if err != nil {
		log.Fatalf("读取信誉数据失败: %v", err)
	}

	if *dryRun {
		fmt.Println("=== 信誉数据预览（dry-run 模式）===")
		for _, data := range reputationData {
			fmt.Printf("节点 %s (%s): 信誉分数 %d\n", data.PeerID, data.Address, data.ReputationScore)
		}
		return
	}

	// 连接到链
	client, err := ethclient.Dial(*rpcURL)
	if err != nil {
		log.Fatalf("连接 RPC 失败: %v", err)
	}
	defer client.Close()

	// 解析私钥
	privateKey, err := crypto.HexToECDSA(*privateKeyHex)
	if err != nil {
		log.Fatalf("解析私钥失败: %v", err)
	}

	chainID, err := client.ChainID(context.Background())
	if err != nil {
		log.Fatalf("获取 ChainID 失败: %v", err)
	}

	auth, err := bind.NewKeyedTransactorWithChainID(privateKey, chainID)
	if err != nil {
		log.Fatalf("创建交易签名器失败: %v", err)
	}

	contractAddress := common.HexToAddress(*contractAddr)
	// 注意：这里需要 ContributorReward 的 ABI，实际使用时需要导入或加载
	// 为了示例，这里只展示逻辑

	fmt.Printf("准备更新 %d 个节点的信誉分数到合约 %s\n", len(reputationData), contractAddress.Hex())

	// 批量更新信誉分数
	addresses := make([]common.Address, 0, len(reputationData))
	scores := make([]*big.Int, 0, len(reputationData))

	for _, data := range reputationData {
		if data.Address == "" {
			log.Printf("跳过节点 %s：无地址", data.PeerID)
			continue
		}
		addresses = append(addresses, common.HexToAddress(data.Address))
		scores = append(scores, new(big.Int).SetUint64(data.ReputationScore))
	}

	if len(addresses) == 0 {
		log.Fatal("没有有效的节点地址")
	}

	// 这里应该调用合约的 setReputationScores 方法
	// 示例代码，实际需要合约 ABI
	fmt.Printf("将更新 %d 个节点的信誉分数\n", len(addresses))
	for i, addr := range addresses {
		fmt.Printf("  %s: %s\n", addr.Hex(), scores[i].String())
	}

	// TODO: 实际调用合约
	// contract, err := NewContributorReward(contractAddress, client)
	// if err != nil {
	//     log.Fatalf("创建合约实例失败: %v", err)
	// }
	// tx, err := contract.SetReputationScores(auth, addresses, scores)
	// if err != nil {
	//     log.Fatalf("提交交易失败: %v", err)
	// }
	// fmt.Printf("交易已提交: %s\n", tx.Hash().Hex())
}

func loadReputationData(filePath string) ([]NodeReputationData, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}

	var result []NodeReputationData
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}

	return result, nil
}

// collectReputationFromRelays 从中继节点收集信誉数据
func collectReputationFromRelays(ctx context.Context, bootstrapPeers []string) (map[peer.ID]*relay.PeerStats, error) {
	// 创建临时 host 用于连接中继节点
	listenAddrs := []string{"/ip4/0.0.0.0/tcp/0"} // 临时端口
	h, err := p2p.NewHost(listenAddrs, "")
	if err != nil {
		return nil, fmt.Errorf("创建 host: %w", err)
	}
	defer h.Close()

	// 连接 bootstrap 节点并收集信誉数据
	// 这里简化处理，实际应该通过 GossipSub 或专用协议收集
	reputationMap := make(map[peer.ID]*relay.PeerStats)

	// TODO: 实现从中继节点收集信誉数据的逻辑
	// 可以通过 GossipSub 主题或专用 API 收集

	return reputationMap, nil
}
