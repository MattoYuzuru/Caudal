package fleet

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	FreshFor   = 90 * time.Second
	maxSamples = 120
	MaxNodes   = 40
)

var (
	ErrUnknown    = errors.New("unknown node")
	ErrCredential = errors.New("invalid node credential")
	ErrLimit      = errors.New("fleet limit reached")
	ErrInvalid    = errors.New("invalid node data")
	ErrTooSoon    = errors.New("heartbeat arrived too soon")
)

type Metrics struct {
	CPUPercent      float64 `json:"cpu_percent"`
	MemoryUsedBytes uint64  `json:"memory_used_bytes"`
	MemoryTotal     uint64  `json:"memory_total_bytes"`
	DiskUsedBytes   uint64  `json:"disk_used_bytes"`
	DiskTotal       uint64  `json:"disk_total_bytes"`
	UptimeSeconds   uint64  `json:"uptime_seconds"`
}

func (m Metrics) valid() bool {
	return !math.IsNaN(m.CPUPercent) && m.CPUPercent >= 0 && m.CPUPercent <= 100 &&
		m.MemoryTotal > 0 && m.MemoryUsedBytes <= m.MemoryTotal &&
		m.DiskTotal > 0 && m.DiskUsedBytes <= m.DiskTotal
}

type Sample struct {
	ObservedAt time.Time `json:"observed_at"`
	Metrics    Metrics   `json:"metrics"`
}

type Node struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Region    string     `json:"region"`
	CreatedAt time.Time  `json:"created_at"`
	LastSeen  *time.Time `json:"last_seen,omitempty"`
	Status    string     `json:"status"`
	Metrics   *Metrics   `json:"metrics,omitempty"`
}

type record struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Region    string            `json:"region"`
	CreatedAt time.Time         `json:"created_at"`
	TokenHash [sha256.Size]byte `json:"token_hash"`
	Samples   []Sample          `json:"samples"`
}

type Store struct {
	dir     string
	lock    *os.File
	now     func() time.Time
	mu      sync.RWMutex
	records map[string]record
	tokens  map[[sha256.Size]byte]string
}

func Open(dir string, now func() time.Time) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("fleet directory must be private")
	}
	lock, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, fmt.Errorf("lock fleet directory: %w", err)
	}
	if now == nil {
		now = time.Now
	}
	store := &Store{dir: dir, lock: lock, now: now,
		records: make(map[string]record), tokens: make(map[[sha256.Size]byte]string)}
	if err := store.load(); err != nil {
		store.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.lock.Close() }

func (s *Store) load() error {
	files, err := os.ReadDir(s.dir)
	if err != nil {
		return err
	}
	for _, file := range files {
		if !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		info, err := file.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 128<<10 {
			return fmt.Errorf("invalid record file %q", file.Name())
		}
		raw, err := os.ReadFile(filepath.Join(s.dir, file.Name()))
		if err != nil {
			return err
		}
		var data record
		if json.Unmarshal(raw, &data) != nil || !data.valid(file.Name()) {
			return fmt.Errorf("invalid fleet record %q", file.Name())
		}
		if _, exists := s.tokens[data.TokenHash]; exists {
			return errors.New("duplicate credential in fleet data")
		}
		s.records[data.ID] = data
		s.tokens[data.TokenHash] = data.ID
	}
	if len(s.records) > MaxNodes {
		return ErrLimit
	}
	return nil
}

func (r record) valid(filename string) bool {
	identifier, err := hex.DecodeString(r.ID)
	if err != nil || len(identifier) != 16 || filename != r.ID+".json" ||
		!validLabel(r.Name, 80, true) || !validLabel(r.Region, 80, false) ||
		r.CreatedAt.IsZero() || r.TokenHash == [sha256.Size]byte{} || len(r.Samples) > maxSamples {
		return false
	}
	previous := r.CreatedAt
	for _, sample := range r.Samples {
		if !sample.Metrics.valid() || sample.ObservedAt.Before(previous) {
			return false
		}
		previous = sample.ObservedAt
	}
	return true
}

func validLabel(value string, maximum int, required bool) bool {
	return (!required || value != "") && utf8.RuneCountInString(value) <= maximum &&
		strings.IndexFunc(value, unicode.IsControl) < 0
}

func (s *Store) Enroll(name, region string) (Node, string, error) {
	name, region = strings.TrimSpace(name), strings.TrimSpace(region)
	if !validLabel(name, 80, true) || !validLabel(region, 80, false) {
		return Node{}, "", ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.records) >= MaxNodes {
		return Node{}, "", ErrLimit
	}
	id := hex.EncodeToString(randBytes(16))
	token := token()
	entry := record{ID: id, Name: name, Region: region, CreatedAt: s.now().UTC(),
		TokenHash: digest(token), Samples: []Sample{}}
	if err := s.save(entry); err != nil {
		return Node{}, "", err
	}
	return entry.node(s.now()), token, nil
}

func (s *Store) Rotate(id string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, exists := s.records[id]
	if !exists {
		return "", ErrUnknown
	}
	newToken := token()
	entry.TokenHash = digest(newToken)
	if err := s.save(entry); err != nil {
		return "", err
	}
	return newToken, nil
}

func (s *Store) Heartbeat(credential string, metrics Metrics) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, valid := s.tokens[digest(credential)]
	if !valid {
		return ErrCredential
	}
	if !metrics.valid() {
		return ErrInvalid
	}
	entry := s.records[id]
	now := s.now().UTC()
	if n := len(entry.Samples); n > 0 && now.Sub(entry.Samples[n-1].ObservedAt) < time.Second {
		return ErrTooSoon
	}
	start := max(0, len(entry.Samples)-maxSamples+1)
	next := make([]Sample, 0, len(entry.Samples)-start+1)
	next = append(next, entry.Samples[start:]...)
	entry.Samples = append(next, Sample{ObservedAt: now, Metrics: metrics})
	return s.save(entry)
}

func (s *Store) List() []Node {
	s.mu.RLock()
	defer s.mu.RUnlock()
	nodes := make([]Node, 0, len(s.records))
	now := s.now()
	for _, entry := range s.records {
		nodes = append(nodes, entry.node(now))
	}
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].Name == nodes[j].Name {
			return nodes[i].ID < nodes[j].ID
		}
		return nodes[i].Name < nodes[j].Name
	})
	return nodes
}

func (s *Store) Node(id string) (Node, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	entry, exists := s.records[id]
	if !exists {
		return Node{}, ErrUnknown
	}
	return entry.node(s.now()), nil
}

func (s *Store) Samples(id string) ([]Sample, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	entry, exists := s.records[id]
	if !exists {
		return nil, ErrUnknown
	}
	return append([]Sample{}, entry.Samples...), nil
}

func (r record) node(now time.Time) Node {
	node := Node{ID: r.ID, Name: r.Name, Region: r.Region, CreatedAt: r.CreatedAt, Status: "pending"}
	if n := len(r.Samples); n > 0 {
		latest := r.Samples[n-1]
		node.LastSeen, node.Metrics = &latest.ObservedAt, &latest.Metrics
		node.Status = "healthy"
		if now.Before(latest.ObservedAt) || now.Sub(latest.ObservedAt) >= FreshFor {
			node.Status = "stale"
		}
	}
	return node
}

func (s *Store) save(data record) error {
	directory, err := os.Open(s.dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	file, err := os.CreateTemp(s.dir, ".record-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	writeErr := json.NewEncoder(file).Encode(data)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	if err := errors.Join(writeErr, file.Close()); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), filepath.Join(s.dir, data.ID+".json")); err != nil {
		return err
	}
	// After rename the new data is visible even if the durability sync fails.
	if prior, exists := s.records[data.ID]; exists && prior.TokenHash != data.TokenHash {
		delete(s.tokens, prior.TokenHash)
	}
	s.records[data.ID] = data
	s.tokens[data.TokenHash] = data.ID
	return directory.Sync()
}

func randBytes(size int) []byte {
	b := make([]byte, size)
	rand.Read(b)
	return b
}

func token() string { return base64.RawURLEncoding.EncodeToString(randBytes(32)) }

func digest(value string) [sha256.Size]byte { return sha256.Sum256([]byte(value)) }
