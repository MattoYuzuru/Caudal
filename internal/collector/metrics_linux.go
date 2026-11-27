//go:build linux

package collector

import (
	"errors"
	"math"
	"os"
	"syscall"
)

// NewSampler creates a sampler for the local host.
func NewSampler() (*Sampler, error) {
	return &Sampler{proc: os.DirFS("/proc"), rootDisk: readRootDisk}, nil
}

func readRootDisk() (used, total uint64, err error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs("/", &stat); err != nil {
		return 0, 0, err
	}
	blockSize := stat.Frsize
	if blockSize <= 0 {
		blockSize = stat.Bsize
	}
	if blockSize <= 0 || stat.Blocks > math.MaxUint64/uint64(blockSize) || stat.Bfree > stat.Blocks {
		return 0, 0, errors.New("invalid root filesystem counters")
	}
	total = stat.Blocks * uint64(blockSize)
	return (stat.Blocks - stat.Bfree) * uint64(blockSize), total, nil
}
