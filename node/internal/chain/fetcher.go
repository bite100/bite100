// Package chain 可选：从链上事件拉取历史成交写入 DB
package chain

import (
	"context"
	"fmt"
	"log"
	"math/big"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"

	"github.com/P2P-P2P/p2p/node/internal/storage"
)

// Swap 事件 topic: keccak256("Swap(address,address,uint256,address,uint256,uint256)")
var swapTopic = common.BytesToHash(crypto.Keccak256([]byte("Swap(address,address,uint256,address,uint256,uint256)")))

// FetchSwapTrades 从 AMMPool 拉取 Swap 事件并写入 DB
func FetchSwapTrades(ctx context.Context, rpcURL, ammPoolAddr, token0, token1 string, fromBlock, toBlock uint64, store *storage.DB) (int, error) {
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return 0, err
	}
	defer client.Close()
	pool := common.HexToAddress(ammPoolAddr)
	query := ethereum.FilterQuery{
		FromBlock: big.NewInt(int64(fromBlock)),
		ToBlock:   big.NewInt(int64(toBlock)),
		Addresses: []common.Address{pool},
		Topics:    [][]common.Hash{{swapTopic}},
	}
	logs, err := client.FilterLogs(ctx, query)
	if err != nil {
		return 0, err
	}
	// ABI: Swap(address indexed sender, address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut, uint256 fee)
	// 事件: sender=topics[1], data=abi.encode(tokenIn,amountIn,tokenOut,amountOut,fee)
	uint256Ty, _ := abi.NewType("uint256", "", nil)
	addressTy, _ := abi.NewType("address", "", nil)
	args := abi.Arguments{
		{Type: addressTy},
		{Type: uint256Ty},
		{Type: addressTy},
		{Type: uint256Ty},
		{Type: uint256Ty},
	}
	pair := common.HexToAddress(token0).Hex() + "/" + common.HexToAddress(token1).Hex()
	if token0 == "" || token1 == "" {
		pair = "tokenIn/tokenOut" // 占位，实际 pair 从事件解析
	}
	var count int
	for _, vLog := range logs {
		if len(vLog.Data) < 32*5 {
			continue
		}
		unpacked, err := args.Unpack(vLog.Data)
		if err != nil {
			log.Printf("[chain] 解析 Swap 事件失败: %v", err)
			continue
		}
		tokenIn := unpacked[0].(common.Address)
		amountIn := unpacked[1].(*big.Int)
		tokenOut := unpacked[2].(common.Address)
		amountOut := unpacked[3].(*big.Int)
		fee := unpacked[4].(*big.Int)
		// price = amountOut/amountIn (简化)
		price := "0"
		if amountIn.Sign() > 0 {
			p := new(big.Float).Quo(
				new(big.Float).SetInt(amountOut),
				new(big.Float).SetInt(amountIn),
			)
			price = p.Text('f', 18)
		}
		block, err := client.BlockByNumber(ctx, big.NewInt(int64(vLog.BlockNumber)))
		if err != nil {
			continue
		}
		tradeID := fmt.Sprintf("%s-%d", vLog.TxHash.Hex(), vLog.Index)
		eventPair := tokenIn.Hex() + "/" + tokenOut.Hex()
		if token0 != "" && token1 != "" {
			eventPair = pair
		}
		t := &storage.Trade{
			TradeID:   tradeID,
			Pair:      eventPair,
			Price:     price,
			Amount:    amountIn.String(),
			Fee:       fee.String(),
			Timestamp: int64(block.Time()),
			TxHash:    vLog.TxHash.Hex(),
		}
		if err := store.InsertTrade(t); err != nil {
			log.Printf("[chain] 写入 trade 失败: %v", err)
			continue
		}
		count++
	}
	return count, nil
}

// FetchRecentSwapTrades 拉取最近区块的 Swap 事件（fromBlock=0 表示自动从 latest-10000 开始）
func FetchRecentSwapTrades(ctx context.Context, rpcURL, ammPoolAddr, token0, token1 string, store *storage.DB) (int, error) {
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return 0, err
	}
	defer client.Close()
	toBlock, err := client.BlockNumber(ctx)
	if err != nil {
		return 0, err
	}
	fromBlock := uint64(0)
	if toBlock > 10000 {
		fromBlock = toBlock - 10000
	}
	return FetchSwapTrades(ctx, rpcURL, ammPoolAddr, token0, token1, fromBlock, toBlock, store)
}
