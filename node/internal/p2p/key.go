package p2p

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/libp2p/go-libp2p/core/crypto"
)

const keyFilename = "peerkey"

// LoadOrCreateKey 从 dataDir/peerkey 加载私钥，不存在则生成并保存
func LoadOrCreateKey(dataDir string) (crypto.PrivKey, error) {
	if dataDir == "" {
		return nil, nil
	}
	path := filepath.Join(dataDir, keyFilename)
	data, err := os.ReadFile(path)
	if err == nil {
		return crypto.UnmarshalPrivateKey(data)
	}
	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("读取密钥: %w", err)
	}
	priv, _, err := crypto.GenerateEd25519Key(nil)
	if err != nil {
		return nil, fmt.Errorf("生成密钥: %w", err)
	}
	raw, err := crypto.MarshalPrivateKey(priv)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, raw, 0600); err != nil {
		return nil, fmt.Errorf("写入密钥: %w", err)
	}
	return priv, nil
}
