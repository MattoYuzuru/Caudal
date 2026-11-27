package fleet

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNodeLifecycle(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fleet")
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	store, err := Open(dir, clock)
	if err != nil {
		t.Fatal(err)
	}
	if competing, err := Open(dir, nil); err == nil {
		competing.Close()
		t.Fatal("another process can open the same fleet")
	}

	if _, _, err := store.Enroll(" ", ""); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad name: %v", err)
	}
	node, credential, err := store.Enroll("  Node A ", " Lab ")
	if err != nil || node.Status != "pending" || node.Name != "Node A" || node.Region != "Lab" || len(credential) != 43 {
		t.Fatalf("unexpected node: %+v (%v)", node, err)
	}
	metrics := Metrics{CPUPercent: 25, MemoryUsedBytes: 25, MemoryTotal: 100, DiskUsedBytes: 30, DiskTotal: 100, UptimeSeconds: 100}
	if err := store.Heartbeat("bad-token", metrics); !errors.Is(err, ErrCredential) {
		t.Fatalf("bad token: %v", err)
	}
	if err := store.Heartbeat(credential, Metrics{}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("bad metrics: %v", err)
	}
	if err := store.Heartbeat(credential, metrics); err != nil {
		t.Fatal(err)
	}
	if err := store.Heartbeat(credential, metrics); !errors.Is(err, ErrTooSoon) {
		t.Fatalf("unthrottled duplicate heartbeat: %v", err)
	}
	reported, err := store.Node(node.ID)
	if err != nil || reported.Status != "healthy" || *reported.Metrics != metrics || !reported.LastSeen.Equal(now) {
		t.Fatalf("heartbeat missing: %+v (%v)", reported, err)
	}

	now = now.Add(FreshFor)
	list := store.List()
	if len(list) != 1 || list[0].Status != "stale" {
		t.Fatalf("stale data lost or listed as healthy: %+v", list)
	}
	replacement, err := store.Rotate(node.ID)
	if err != nil || replacement == credential {
		t.Fatal("credential did not rotate")
	}
	if err := store.Heartbeat(credential, metrics); !errors.Is(err, ErrCredential) {
		t.Fatal("old credential still works")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	persisted, err := os.ReadFile(filepath.Join(dir, node.ID+".json"))
	if err != nil || bytes.Contains(persisted, []byte(credential)) || bytes.Contains(persisted, []byte(replacement)) {
		t.Fatal("state unreadable or contains a raw token")
	}
	store, err = Open(dir, clock)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.Heartbeat(replacement, metrics); err != nil {
		t.Fatal(err)
	}
	observations, err := store.Samples(node.ID)
	if err != nil || len(observations) != 2 || !observations[1].ObservedAt.After(observations[0].ObservedAt) {
		t.Fatalf("history did not survive restart: %+v (%v)", observations, err)
	}
	observations[0] = Sample{}
	again, err := store.Samples(node.ID)
	if err != nil || again[0].ObservedAt.IsZero() {
		t.Fatal("caller mutated stored samples")
	}
	if _, err := store.Node("missing"); !errors.Is(err, ErrUnknown) {
		t.Fatalf("missing node: %v", err)
	}
	if _, err := store.Samples("missing"); !errors.Is(err, ErrUnknown) {
		t.Fatalf("missing samples: %v", err)
	}
	if _, err := store.Rotate("missing"); !errors.Is(err, ErrUnknown) {
		t.Fatalf("missing credential: %v", err)
	}
}

func TestSampleRetention(t *testing.T) {
	now := time.Now()
	store, err := Open(filepath.Join(t.TempDir(), "fleet"), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	node, token, err := store.Enroll("Retention", "")
	if err != nil {
		t.Fatal(err)
	}
	for i := range maxSamples + 3 {
		now = now.Add(time.Second)
		if err := store.Heartbeat(token, Metrics{MemoryTotal: 1024, DiskTotal: 2048, UptimeSeconds: uint64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	samples, err := store.Samples(node.ID)
	if err != nil || len(samples) != maxSamples || samples[0].Metrics.UptimeSeconds != 3 {
		t.Fatalf("incorrect history retention: %d (%v)", len(samples), err)
	}
}

func TestInvalidStorage(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fleet")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir, nil); err == nil {
		t.Fatal("accepted public directory")
	}
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bad.json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir, nil); err == nil {
		t.Fatal("accepted an invalid record")
	}
}
