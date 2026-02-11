// MerkleDistributor 工具：从「地址,金额」列表生成 Merkle root 与 proof，供 MerkleDistributor.claim 使用
// 叶子：keccak256(abi.encodePacked(index, account, amount))，与 MerkleProof.sol 排序一致
package main

import (
	"bufio"
	"encoding/csv"
	"flag"
	"fmt"
	"math/big"
	"os"
	"sort"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

func main() {
	listPath := flag.String("list", "", "奖励列表 CSV：address,amount（每行，amount 为最小单位如 wei）")
	addr := flag.String("proof-for", "", "输出该地址的 proof（用于 claim）")
	flag.Parse()

	if *listPath == "" {
		fmt.Fprintln(os.Stderr, "用法: merkle-distributor -list rewards.csv [-proof-for 0x...]")
		fmt.Fprintln(os.Stderr, "  rewards.csv 格式: address,amount (每行)")
		os.Exit(1)
	}

	entries, err := readRewards(*listPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "读取奖励列表: %v\n", err)
		os.Exit(1)
	}
	if len(entries) == 0 {
		fmt.Fprintln(os.Stderr, "奖励列表为空")
		os.Exit(1)
	}

	leaves := make([][32]byte, len(entries))
	for i, e := range entries {
		leaves[i] = leafHash(uint64(i), e.addr, e.amount)
	}
	sort.Slice(leaves, func(i, j int) bool { return bytesLess(leaves[i][:], leaves[j][:]) })

	root, levels := buildTree(leaves)
	total := big.NewInt(0)
	for _, e := range entries {
		total.Add(total, e.amount)
	}
	fmt.Printf("merkleRoot: 0x%x\n", root)
	fmt.Printf("totalAmount: %s\n", total.String())

	if *addr != "" {
		account := common.HexToAddress(*addr)
		idx := -1
		for i, e := range entries {
			if e.addr == account {
				idx = i
				break
			}
		}
		if idx < 0 {
			fmt.Fprintf(os.Stderr, "地址 %s 不在列表中\n", *addr)
			os.Exit(1)
		}
		leaf := leafHash(uint64(idx), entries[idx].addr, entries[idx].amount)
		proof, err := getProof(leaves, levels, leaf)
		if err != nil {
			fmt.Fprintf(os.Stderr, "生成 proof: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("index: %d\n", idx)
		fmt.Printf("amount: %s\n", entries[idx].amount.String())
		fmt.Println("proof (用于 claim):")
		for _, p := range proof {
			fmt.Printf("  0x%x\n", p)
		}
		fmt.Print("proof (hex 数组): [")
		for i, p := range proof {
			if i > 0 {
				fmt.Print(",")
			}
			fmt.Printf("\"0x%x\"", p)
		}
		fmt.Println("]")
	}
}

type entry struct {
	addr   common.Address
	amount *big.Int
}

func readRewards(path string) ([]entry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	r := csv.NewReader(bufio.NewReader(f))
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return nil, err
	}
	var entries []entry
	for _, row := range rows {
		if len(row) < 2 {
			continue
		}
		addrStr := strings.TrimSpace(row[0])
		amountStr := strings.TrimSpace(row[1])
		if addrStr == "" || amountStr == "" || strings.HasPrefix(addrStr, "#") {
			continue
		}
		if !common.IsHexAddress(addrStr) {
			continue
		}
		amt := new(big.Int)
		if _, ok := amt.SetString(amountStr, 10); !ok {
			continue
		}
		entries = append(entries, entry{common.HexToAddress(addrStr), amt})
	}
	return entries, nil
}

// leaf = keccak256(abi.encodePacked(index, account, amount))，与 MerkleDistributor.sol 一致
func leafHash(index uint64, account common.Address, amount *big.Int) [32]byte {
	idxBytes := common.LeftPadBytes(new(big.Int).SetUint64(index).Bytes(), 32)
	amtBytes := common.LeftPadBytes(amount.Bytes(), 32)
	data := append(idxBytes, account.Bytes()...)
	data = append(data, amtBytes...)
	return crypto.Keccak256Hash(data)
}

func bytesLess(a, b []byte) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

func buildTree(leaves [][32]byte) ([32]byte, [][][32]byte) {
	levels := [][][32]byte{leaves}
	for len(levels[len(levels)-1]) > 1 {
		cur := levels[len(levels)-1]
		var next [][32]byte
		for i := 0; i < len(cur); i += 2 {
			if i+1 >= len(cur) {
				next = append(next, cur[i])
				break
			}
			a, b := cur[i], cur[i+1]
			if bytesLess(b[:], a[:]) {
				a, b = b, a
			}
			next = append(next, crypto.Keccak256Hash(append(a[:], b[:]...)))
		}
		levels = append(levels, next)
	}
	return levels[len(levels)-1][0], levels
}

func getProof(leaves [][32]byte, levels [][][32]byte, leaf [32]byte) ([][32]byte, error) {
	idx := -1
	for i, l := range leaves {
		if l == leaf {
			idx = i
			break
		}
	}
	if idx < 0 {
		return nil, fmt.Errorf("leaf not in tree")
	}
	var proof [][32]byte
	for L := 0; L < len(levels)-1; L++ {
		siblingIdx := idx ^ 1
		if siblingIdx < len(levels[L]) {
			proof = append(proof, levels[L][siblingIdx])
		}
		idx = idx / 2
	}
	return proof, nil
}
