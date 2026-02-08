package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"sort"
)

// TradeData 表示一个 Trade 的数据（用于生成默克尔树）
type TradeData struct {
	Maker           string
	Taker           string
	TokenIn         string
	TokenOut        string
	AmountIn        string
	AmountOut       string
	GasReimburseIn  string
	GasReimburseOut string
}

// HashTrade 计算 Trade 的叶子哈希（与合约中的 keccak256(abi.encodePacked(...)) 一致）
func HashTrade(t TradeData) []byte {
	// 注意：Solidity 的 abi.encodePacked 会按顺序拼接，字符串/地址会直接拼接
	// 这里简化处理，实际应使用与 Solidity 一致的编码方式
	data := fmt.Sprintf("%s%s%s%s%s%s%s%s",
		t.Maker, t.Taker, t.TokenIn, t.TokenOut,
		t.AmountIn, t.AmountOut, t.GasReimburseIn, t.GasReimburseOut)
	hash := sha256.Sum256([]byte(data))
	return hash[:]
}

// BuildMerkleTree 构建默克尔树并返回根和每个叶子的证明路径
func BuildMerkleTree(trades []TradeData) ([]byte, [][]byte, [][][]byte) {
	if len(trades) == 0 {
		return nil, nil, nil
	}

	// 计算所有叶子哈希
	leaves := make([][]byte, len(trades))
	for i, t := range trades {
		leaves[i] = HashTrade(t)
	}

	// 构建默克尔树
	tree := make([][]byte, 0)
	tree = append(tree, leaves...)

	currentLevel := leaves
	level := 0

	for len(currentLevel) > 1 {
		nextLevel := make([][]byte, 0)
		for i := 0; i < len(currentLevel); i += 2 {
			if i+1 < len(currentLevel) {
				// 两个节点，计算父节点
				left := currentLevel[i]
				right := currentLevel[i+1]
				parent := hashPair(left, right)
				nextLevel = append(nextLevel, parent)
				tree = append(tree, parent)
			} else {
				// 奇数个节点，最后一个节点直接上移
				nextLevel = append(nextLevel, currentLevel[i])
			}
		}
		currentLevel = nextLevel
		level++
	}

	root := currentLevel[0]

	// 为每个叶子生成证明路径
	proofs := make([][][]byte, len(trades))
	for i := 0; i < len(trades); i++ {
		proofs[i] = generateProof(tree, i, len(leaves))
	}

	return root, leaves, proofs
}

// hashPair 计算两个节点的父节点哈希（与 MerkleProof.sol 的排序逻辑一致）
func hashPair(left, right []byte) []byte {
	var combined []byte
	if string(left) <= string(right) {
		combined = append(combined, left...)
		combined = append(combined, right...)
	} else {
		combined = append(combined, right...)
		combined = append(combined, left...)
	}
	hash := sha256.Sum256(combined)
	return hash[:]
}

// generateProof 为指定索引的叶子生成默克尔证明
func generateProof(tree [][]byte, leafIndex int, leafCount int) [][]byte {
	proof := make([][]byte, 0)
	index := leafIndex

	for leafCount > 1 {
		if index%2 == 0 {
			// 左节点，需要右兄弟
			if index+1 < leafCount {
				proof = append(proof, tree[index+1])
			}
		} else {
			// 右节点，需要左兄弟
			proof = append(proof, tree[index-1])
		}
		index /= 2
		leafCount = (leafCount + 1) / 2
	}

	return proof
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("用法: merkle_trades <trade1> <trade2> ...")
		fmt.Println("每个 trade 格式: maker,taker,tokenIn,tokenOut,amountIn,amountOut,gasIn,gasOut")
		os.Exit(1)
	}

	trades := make([]TradeData, 0)
	for i := 1; i < len(os.Args); i++ {
		parts := splitTrade(os.Args[i])
		if len(parts) != 8 {
			fmt.Printf("错误: 第 %d 个 trade 格式不正确\n", i)
			os.Exit(1)
		}
		trades = append(trades, TradeData{
			Maker:           parts[0],
			Taker:           parts[1],
			TokenIn:         parts[2],
			TokenOut:        parts[3],
			AmountIn:        parts[4],
			AmountOut:       parts[5],
			GasReimburseIn:  parts[6],
			GasReimburseOut: parts[7],
		})
	}

	root, leaves, proofs := BuildMerkleTree(trades)

	fmt.Printf("默克尔根: 0x%s\n", hex.EncodeToString(root))
	fmt.Printf("\n叶子哈希:\n")
	for i, leaf := range leaves {
		fmt.Printf("  Trade %d: 0x%s\n", i, hex.EncodeToString(leaf))
	}
	fmt.Printf("\n证明路径:\n")
	for i, proof := range proofs {
		fmt.Printf("  Trade %d:\n", i)
		for j, p := range proof {
			fmt.Printf("    [%d]: 0x%s\n", j, hex.EncodeToString(p))
		}
	}
}

func splitTrade(s string) []string {
	parts := make([]string, 0)
	current := ""
	for _, c := range s {
		if c == ',' {
			parts = append(parts, current)
			current = ""
		} else {
			current += string(c)
		}
	}
	if current != "" {
		parts = append(parts, current)
	}
	return parts
}
