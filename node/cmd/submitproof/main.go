// 链上提交贡献证明：读证明 JSON，用 EVM 私钥签名并调用 ContributorReward.submitProof
// 用法：go run ./cmd/submitproof -proof <path> -contract <addr> -rpc <url> -key <hex 或 0x...>
// 环境变量：REWARD_ETH_PRIVATE_KEY 可替代 -key（-key 优先）
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"math/big"
	"os"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/P2P-P2P/p2p/node/internal/metrics"
	"github.com/P2P-P2P/p2p/node/internal/reward"
)

func main() {
	proofPath := flag.String("proof", "", "贡献证明 JSON 文件路径（必填）")
	contractAddr := flag.String("contract", "", "ContributorReward 合约地址（必填）")
	rpcURL := flag.String("rpc", "http://127.0.0.1:8545", "链 RPC URL")
	keyHex := flag.String("key", "", "EVM 私钥（十六进制，0x 可选）；未填则读 REWARD_ETH_PRIVATE_KEY")
	flag.Parse()

	if *proofPath == "" || *contractAddr == "" {
		flag.Usage()
		log.Fatal("必须指定 -proof 与 -contract")
	}

	if *keyHex == "" {
		*keyHex = os.Getenv("REWARD_ETH_PRIVATE_KEY")
	}
	if *keyHex == "" {
		log.Fatal("未设置 -key 或 REWARD_ETH_PRIVATE_KEY")
	}

	data, err := os.ReadFile(*proofPath)
	if err != nil {
		log.Fatalf("读取证明文件: %v", err)
	}
	var p metrics.ContributionProof
	if err := json.Unmarshal(data, &p); err != nil {
		log.Fatalf("解析证明 JSON: %v", err)
	}

	calldata, err := reward.BuildSignedCalldata(&p, *keyHex)
	if err != nil {
		log.Fatalf("构建签名与 calldata: %v", err)
	}

	client, err := ethclient.Dial(*rpcURL)
	if err != nil {
		log.Fatalf("连接 RPC: %v", err)
	}
	ctx := context.Background()

	keyHexTrim := *keyHex
	if len(keyHexTrim) >= 2 && keyHexTrim[0:2] == "0x" {
		keyHexTrim = keyHexTrim[2:]
	}
	keyBytes := common.FromHex("0x" + keyHexTrim)
	if len(keyBytes) != 32 {
		log.Fatal("无效私钥（需 32 字节十六进制）")
	}
	key, err := crypto.ToECDSA(keyBytes)
	if err != nil {
		log.Fatalf("私钥格式: %v", err)
	}

	chainID, err := client.ChainID(ctx)
	if err != nil {
		log.Fatalf("获取 chainId: %v", err)
	}
	nonce, err := client.PendingNonceAt(ctx, crypto.PubkeyToAddress(key.PublicKey))
	if err != nil {
		log.Fatalf("获取 nonce: %v", err)
	}
	gasPrice, err := client.SuggestGasPrice(ctx)
	if err != nil {
		log.Fatalf("获取 gas price: %v", err)
	}

	tx := types.NewTransaction(
		nonce,
		common.HexToAddress(*contractAddr),
		big.NewInt(0),
		300000,
		gasPrice,
		calldata,
	)
	signedTx, err := types.SignTx(tx, types.NewEIP155Signer(chainID), key)
	if err != nil {
		log.Fatalf("签名交易: %v", err)
	}
	if err := client.SendTransaction(ctx, signedTx); err != nil {
		log.Fatalf("发送交易: %v", err)
	}
	log.Printf("submitProof 交易已发送: %s", signedTx.Hash().Hex())
}
