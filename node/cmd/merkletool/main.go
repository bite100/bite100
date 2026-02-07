// 治理提案默克尔树工具：从「最近 4 周活跃地址」列表生成 root 与 proof，供 createProposal / vote 使用
// 叶子与合约一致：leaf = keccak256(abi.encodePacked(addr))，即 keccak256(20字节地址)
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

func main() {
	listPath := flag.String("list", "", "地址列表文件，每行一个 0x 地址")
	addr := flag.String("proof-for", "", "输出该地址的 proof（hex 数组，用于 vote）")
	flag.Parse()

	if *listPath == "" {
		fmt.Fprintln(os.Stderr, "用法: merkletool -list addresses.txt [-proof-for 0x...]")
		fmt.Fprintln(os.Stderr, "  -list: 活跃地址列表，每行一个地址")
		fmt.Fprintln(os.Stderr, "  -proof-for: 若指定，输出该地址的 proof 供链上 vote 使用")
		os.Exit(1)
	}

	addrs, err := readAddresses(*listPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "读取地址列表: %v\n", err)
		os.Exit(1)
	}
	if len(addrs) == 0 {
		fmt.Fprintln(os.Stderr, "地址列表为空")
		os.Exit(1)
	}

	leaves := make([][32]byte, len(addrs))
	for i, a := range addrs {
		leaves[i] = leafHash(a)
	}
	sort.Slice(leaves, func(i, j int) bool {
		return bytesLess(leaves[i][:], leaves[j][:])
	})

	root, levels := buildTree(leaves)
	fmt.Printf("merkleRoot: 0x%x\n", root)
	fmt.Printf("activeCount: %d\n", len(addrs))

	if *addr != "" {
		account := common.HexToAddress(*addr)
		leaf := leafHash(account)
		proof, err := getProof(leaves, levels, leaf)
		if err != nil {
			fmt.Fprintf(os.Stderr, "生成 proof: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("proof (用于 vote):")
		for _, p := range proof {
			fmt.Printf("  0x%x\n", p)
		}
		// 也可输出为 JSON 数组供 cast 等使用
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

func readAddresses(path string) ([]common.Address, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	seen := make(map[common.Address]bool)
	var addrs []common.Address
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !common.IsHexAddress(line) {
			continue
		}
		a := common.HexToAddress(line)
		if seen[a] {
			continue
		}
		seen[a] = true
		addrs = append(addrs, a)
	}
	return addrs, sc.Err()
}

// leaf 与 Governance 一致：keccak256(abi.encodePacked(addr))
func leafHash(addr common.Address) [32]byte {
	return crypto.Keccak256Hash(addr.Bytes())
}

func bytesLess(a, b []byte) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

// buildTree 返回 root 与每一层的节点（level[0]=leaves, level[1]=父层...）
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
	root := levels[len(levels)-1][0]
	return root, levels
}

// getProof 返回 leaf 对应的 proof 数组（从叶到根顺序的兄弟节点）
func getProof(leaves [][32]byte, levels [][][32]byte, leaf [32]byte) ([][32]byte, error) {
	idx := -1
	for i, l := range leaves {
		if l == leaf {
			idx = i
			break
		}
	}
	if idx < 0 {
		return nil, fmt.Errorf("address not in list")
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
