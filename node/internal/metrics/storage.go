package metrics

import (
	"os"
	"path/filepath"
)

// StorageUsage 返回 dataDir 下已用字节数；totalBytes 可选，传 0 则仅返回 used
func StorageUsage(dataDir string) (usedBytes int64, totalBytes int64) {
	usedBytes = dirSize(dataDir)
	// 总容量需要 syscall 或 exec 查询磁盘，简化：仅返回 used，total 由调用方填 0 或估算
	return usedBytes, 0
}

func dirSize(path string) int64 {
	var size int64
	filepath.Walk(path, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() {
			size += info.Size()
		}
		return nil
	})
	return size
}
