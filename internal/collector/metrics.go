package collector

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"strconv"
	"strings"
	"time"
)

// Metrics describes one observation of a Linux host.
type Metrics struct {
	CPUPercent       float64 `json:"cpu_percent"`
	MemoryUsedBytes  uint64  `json:"memory_used_bytes"`
	MemoryTotalBytes uint64  `json:"memory_total_bytes"`
	DiskUsedBytes    uint64  `json:"disk_used_bytes"`
	DiskTotalBytes   uint64  `json:"disk_total_bytes"`
	UptimeSeconds    uint64  `json:"uptime_seconds"`
}

const cpuWarmup = 250 * time.Millisecond

// Sampler collects aggregate host metrics. Call Read serially to preserve its CPU baseline.
type Sampler struct {
	proc     fs.FS
	rootDisk func() (used, total uint64, err error)
	previous *cpuTicks
}

func (s *Sampler) Read(ctx context.Context) (Metrics, error) {
	if err := ctx.Err(); err != nil {
		return Metrics{}, err
	}
	if s.previous == nil {
		baseline, err := s.readCPU()
		if err != nil {
			return Metrics{}, err
		}
		timer := time.NewTimer(cpuWarmup)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return Metrics{}, ctx.Err()
		case <-timer.C:
			s.previous = &baseline
		}
	}
	current, err := s.readCPU()
	if err != nil {
		return Metrics{}, err
	}
	percent, err := cpuPercent(*s.previous, current)
	s.previous = &current
	if err != nil {
		return Metrics{}, err
	}

	memoryUsed, memoryTotal, err := s.readMemory()
	if err != nil {
		return Metrics{}, err
	}
	diskUsed, diskTotal, err := s.rootDisk()
	if err != nil {
		return Metrics{}, fmt.Errorf("read root filesystem: %w", err)
	}
	uptime, err := s.readUptime()
	if err != nil {
		return Metrics{}, err
	}
	return Metrics{
		CPUPercent:       percent,
		MemoryUsedBytes:  memoryUsed,
		MemoryTotalBytes: memoryTotal,
		DiskUsedBytes:    diskUsed,
		DiskTotalBytes:   diskTotal,
		UptimeSeconds:    uptime,
	}, nil
}

// Linux already includes guest time in user and nice, so only the first eight fields contribute.
type cpuTicks [8]uint64

func (s *Sampler) readCPU() (cpuTicks, error) {
	file, err := s.proc.Open("stat")
	if err != nil {
		return cpuTicks{}, fmt.Errorf("open /proc/stat: %w", err)
	}
	defer file.Close()
	scan := bufio.NewScanner(file)
	if !scan.Scan() {
		return cpuTicks{}, errors.New("read aggregate CPU counters from /proc/stat")
	}
	return parseCPU(scan.Text())
}

func parseCPU(line string) (cpuTicks, error) {
	var ticks cpuTicks
	fields := strings.Fields(line)
	if len(fields) < len(ticks)+1 || fields[0] != "cpu" {
		return ticks, errors.New("invalid aggregate CPU counters")
	}
	for index := range ticks {
		value, err := strconv.ParseUint(fields[index+1], 10, 64)
		if err != nil {
			return cpuTicks{}, errors.New("invalid aggregate CPU counter")
		}
		ticks[index] = value
	}
	return ticks, nil
}

func cpuPercent(previous, current cpuTicks) (float64, error) {
	var total, idle uint64
	for index, ticks := range current {
		if ticks < previous[index] {
			// Linux documents that the iowait counter may decrease.
			if index == 4 {
				continue
			}
			return 0, errors.New("CPU counters reset between observations")
		}
		delta := ticks - previous[index]
		total += delta
		if index == 3 || index == 4 {
			idle += delta
		}
	}
	if total == 0 {
		return 0, errors.New("CPU counters have not advanced")
	}
	return 100 * float64(total-idle) / float64(total), nil
}

func (s *Sampler) readMemory() (used, total uint64, err error) {
	file, err := s.proc.Open("meminfo")
	if err != nil {
		return 0, 0, fmt.Errorf("open /proc/meminfo: %w", err)
	}
	defer file.Close()
	return parseMemory(file)
}

func parseMemory(file io.Reader) (used, total uint64, err error) {
	var available uint64
	var hasAvailable bool
	scan := bufio.NewScanner(file)
	for scan.Scan() {
		name, value, _ := strings.Cut(scan.Text(), ":")
		if name != "MemTotal" && name != "MemAvailable" {
			continue
		}
		fields := strings.Fields(value)
		if len(fields) != 2 || fields[1] != "kB" {
			return 0, 0, errors.New("invalid memory units")
		}
		kilobytes, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil || kilobytes > math.MaxUint64/1024 {
			return 0, 0, errors.New("invalid memory counter")
		}
		if name == "MemTotal" {
			total = kilobytes * 1024
		} else {
			available = kilobytes * 1024
			hasAvailable = true
		}
		if total > 0 && hasAvailable {
			break
		}
	}
	if err := scan.Err(); err != nil {
		return 0, 0, fmt.Errorf("read /proc/meminfo: %w", err)
	}
	if total == 0 || !hasAvailable || available > total {
		return 0, 0, errors.New("incomplete or invalid memory counters")
	}
	return total - available, total, nil
}

func (s *Sampler) readUptime() (uint64, error) {
	contents, err := fs.ReadFile(s.proc, "uptime")
	if err != nil {
		return 0, fmt.Errorf("read /proc/uptime: %w", err)
	}
	fields := strings.Fields(string(contents))
	if len(fields) == 0 {
		return 0, errors.New("missing uptime counter")
	}
	seconds, _, _ := strings.Cut(fields[0], ".")
	uptime, err := strconv.ParseUint(seconds, 10, 64)
	if err != nil {
		return 0, errors.New("invalid uptime counter")
	}
	return uptime, nil
}
