// Package reward 提供贡献证明的链上提交：按贡献奖励接口对 payload 做 ECDSA 签名并编码 submitProof 调用
package reward

import (
	"encoding/hex"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/P2P-P2P/p2p/node/internal/metrics"
)

const scale18 = 1e18

// SubmitProofArgs 与合约 submitProof(period, uptime, storageUsedGB, storageTotalGB, bytesRelayed, nodeType, signature) 对应
type SubmitProofArgs struct {
	Period         string
	Uptime         *big.Int // [0, 1e18]
	StorageUsedGB  *big.Int
	StorageTotalGB *big.Int
	BytesRelayed   *big.Int
	NodeType       uint8 // 0=relay, 1=storage
}

// Digest 计算合约端相同的 digest：keccak256(abi.encodePacked(period, uptime, storageUsedGB, storageTotalGB, bytesRelayed, nodeType))
func Digest(args *SubmitProofArgs) ([]byte, error) {
	// abi.encodePacked 对 string 按 UTF-8 字节、对 uint 按 32 字节大端编码后紧密拼接
	periodBytes := []byte(args.Period)
	packed := make([]byte, 0, len(periodBytes)+32*5+1)
	packed = append(packed, periodBytes...)
	packed = append(packed, common.LeftPadBytes(args.Uptime.Bytes(), 32)...)
	packed = append(packed, common.LeftPadBytes(args.StorageUsedGB.Bytes(), 32)...)
	packed = append(packed, common.LeftPadBytes(args.StorageTotalGB.Bytes(), 32)...)
	packed = append(packed, common.LeftPadBytes(args.BytesRelayed.Bytes(), 32)...)
	packed = append(packed, args.NodeType)
	hash := crypto.Keccak256(packed)
	return hash, nil
}

// SignDigest 用 EVM 私钥对 digest 做 ECDSA 签名，返回 65 字节 r||s||v（与合约要求一致）
func SignDigest(digest []byte, privateKeyHex string) ([]byte, error) {
	if len(privateKeyHex) >= 2 && privateKeyHex[0:2] == "0x" {
		privateKeyHex = privateKeyHex[2:]
	}
	keyBytes, err := hex.DecodeString(privateKeyHex)
	if err != nil {
		return nil, fmt.Errorf("decode private key: %w", err)
	}
	key, err := crypto.ToECDSA(keyBytes)
	if err != nil {
		return nil, fmt.Errorf("ecdsa key: %w", err)
	}
	sig, err := crypto.Sign(digest, key)
	if err != nil {
		return nil, err
	}
	// go-ethereum 返回 65 字节，v 为 0/1，合约需要 27/28
	if sig[64] < 27 {
		sig[64] += 27
	}
	return sig, nil
}

// EncodeSubmitProof 编码 submitProof(string,uint256,uint256,uint256,uint256,uint8,bytes) 的 calldata
func EncodeSubmitProof(args *SubmitProofArgs, signature []byte) ([]byte, error) {
	argString, _ := abi.NewType("string", "", nil)
	argUint, _ := abi.NewType("uint256", "", nil)
	argUint8, _ := abi.NewType("uint8", "", nil)
	argBytes, _ := abi.NewType("bytes", "", nil)
	argsList := abi.Arguments{
		{Name: "period", Type: argString},
		{Name: "uptime", Type: argUint},
		{Name: "storageUsedGB", Type: argUint},
		{Name: "storageTotalGB", Type: argUint},
		{Name: "bytesRelayed", Type: argUint},
		{Name: "nodeType", Type: argUint8},
		{Name: "signature", Type: argBytes},
	}
	encoded, err := argsList.Pack(
		args.Period,
		args.Uptime,
		args.StorageUsedGB,
		args.StorageTotalGB,
		args.BytesRelayed,
		args.NodeType,
		signature,
	)
	if err != nil {
		return nil, err
	}
	sel := crypto.Keccak256([]byte("submitProof(string,uint256,uint256,uint256,uint256,uint8,bytes)"))[:4]
	return append(sel, encoded...), nil
}

// ArgsFromProof 从链下贡献证明 JSON 结构构建链上 submitProof 入参（uptime 转为 1e18 精度）
func ArgsFromProof(p *metrics.ContributionProof) (*SubmitProofArgs, error) {
	f := new(big.Float).SetFloat64(p.Metrics.Uptime)
	f.Mul(f, new(big.Float).SetFloat64(1e18))
	uptimeScaled := new(big.Int)
	f.Int(uptimeScaled)
	if uptimeScaled.Cmp(new(big.Int).SetUint64(scale18)) > 0 {
		uptimeScaled = new(big.Int).SetUint64(scale18)
	}
	var nodeType uint8
	switch p.NodeType {
	case "relay":
		nodeType = 0
	case "storage":
		nodeType = 1
	default:
		nodeType = 0
	}
	return &SubmitProofArgs{
		Period:         p.Period,
		Uptime:         uptimeScaled,
		StorageUsedGB:  big.NewInt(int64(p.Metrics.StorageUsedGB)),
		StorageTotalGB: big.NewInt(int64(p.Metrics.StorageTotalGB)),
		BytesRelayed:   new(big.Int).SetUint64(p.Metrics.BytesRelayed),
		NodeType:       nodeType,
	}, nil
}

// BuildSignedCalldata 从证明与 EVM 私钥生成已签名的 submitProof calldata（调用方用此 data 发交易）
func BuildSignedCalldata(p *metrics.ContributionProof, privateKeyHex string) ([]byte, error) {
	args, err := ArgsFromProof(p)
	if err != nil {
		return nil, err
	}
	digest, err := Digest(args)
	if err != nil {
		return nil, err
	}
	sig, err := SignDigest(digest, privateKeyHex)
	if err != nil {
		return nil, err
	}
	return EncodeSubmitProof(args, sig)
}
