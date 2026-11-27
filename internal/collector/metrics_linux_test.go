//go:build linux

package collector

import "testing"

func TestLinuxSamplerReadsCurrentHost(t *testing.T) {
	sampler, err := NewSampler()
	if err != nil {
		t.Fatal(err)
	}
	metrics, err := sampler.Read(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if metrics.MemoryTotalBytes == 0 || metrics.MemoryUsedBytes > metrics.MemoryTotalBytes ||
		metrics.DiskTotalBytes == 0 || metrics.DiskUsedBytes > metrics.DiskTotalBytes ||
		metrics.CPUPercent < 0 || metrics.CPUPercent > 100 {
		t.Fatalf("metric values out of range: %+v", metrics)
	}
}
