package collector

import (
	"context"
	"errors"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
)

func TestReadHostMetrics(t *testing.T) {
	prior := cpuTicks{100, 0, 40, 100, 30, 0, 0, 0}
	sampler := &Sampler{
		proc: fstest.MapFS{
			"stat":    {Data: []byte("cpu 120 0 50 160 40 0 0 0 99 99\ncpu0 80 0 0 10\n")},
			"meminfo": {Data: []byte("MemTotal: 1024 kB\nMemFree: 100 kB\nMemAvailable: 512 kB\n")},
			"uptime":  {Data: []byte("123.99 928.45\n")},
		},
		rootDisk: func() (uint64, uint64, error) { return 70, 100, nil },
		previous: &prior,
	}
	metrics, err := sampler.Read(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	want := Metrics{
		CPUPercent:       30,
		MemoryUsedBytes:  512 * 1024,
		MemoryTotalBytes: 1024 * 1024,
		DiskUsedBytes:    70,
		DiskTotalBytes:   100,
		UptimeSeconds:    123,
	}
	if metrics != want {
		t.Fatalf("metrics = %+v, want %+v", metrics, want)
	}

	// Sampling unchanged counters must not report 0 percent as an observation.
	if _, err := sampler.Read(t.Context()); err == nil {
		t.Fatal("expected a missing CPU delta error")
	}
}

func TestCPUCounterEdgeCases(t *testing.T) {
	for _, malformed := range []string{"cpu1 1 2 3 4 5 6 7 8", "cpu 1 2", "cpu 1 2 3 4 5 6 7 -1"} {
		if _, err := parseCPU(malformed); err == nil {
			t.Fatalf("parseCPU(%q) accepted an invalid aggregate", malformed)
		}
	}
	prev := cpuTicks{1, 2, 3, 4, 10, 7, 8, 9}
	current := cpuTicks{2, 2, 3, 5, 9, 7, 8, 9}
	if percent, err := cpuPercent(prev, current); err != nil || percent != 50 {
		t.Fatalf("with a smaller iowait, CPU percent = %f, error = %v", percent, err)
	}
	if _, err := cpuPercent(current, prev); err == nil {
		t.Fatal("expected an error after the user counter reset")
	}
}

func TestMemoryRequiresLinuxAvailability(t *testing.T) {
	tests := []string{
		"MemTotal: 1024 kB\nMemFree: 512 kB\n",
		"MemTotal: 1024 kB\nMemAvailable: 1025 kB\n",
		"MemTotal: 1024 kb\nMemAvailable: 512 kB\n",
		"MemTotal: 18446744073709551615 kB\nMemAvailable: 512 kB\n",
		"MemTotal: 0 kB\nMemAvailable: 0 kB\n",
	}
	for _, info := range tests {
		if _, _, err := parseMemory(strings.NewReader(info)); err == nil {
			t.Fatalf("parseMemory(%q) accepted invalid data", info)
		}
	}
	if used, total, err := parseMemory(strings.NewReader("MemAvailable: 0 kB\nMemTotal: 1024 kB\n")); err != nil || used != total || total == 0 {
		t.Fatalf("full memory: used = %d, total = %d, error = %v", used, total, err)
	}
}

func TestSamplerHonorsCancellationAndUnavailableSources(t *testing.T) {
	sampler := &Sampler{proc: fstest.MapFS{}}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := sampler.Read(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Read returned %v after cancellation", err)
	}
	if _, err := sampler.Read(t.Context()); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Read without /proc/stat returned %v", err)
	}
}
