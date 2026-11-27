package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestIntervalIsInsideHeartbeatFreshnessWindow(t *testing.T) {
	for raw, want := range map[string]time.Duration{"": 30 * time.Second, "5s": 5 * time.Second, "1m": time.Minute} {
		interval, err := parseInterval(raw)
		if err != nil || interval != want {
			t.Errorf("parseInterval(%q) = %v, %v, want %v", raw, interval, err, want)
		}
	}
	for _, raw := range []string{"never", "4s", "61s"} {
		if _, err := parseInterval(raw); err == nil {
			t.Errorf("parseInterval accepted %q", raw)
		}
	}
}

func TestTokenSources(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("synthetic-token\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if token, err := readToken("", path); err != nil || token != "synthetic-token" {
		t.Fatal("did not read a private token file")
	}
	if token, err := readToken("synthetic-token", ""); err != nil || token != "synthetic-token" {
		t.Fatal("did not read an inline token")
	}
	if _, err := readToken("synthetic-token", path); err == nil {
		t.Fatal("accepted both token sources")
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := readToken("", path); err == nil {
		t.Fatal("accepted a publicly readable token file")
	}
	if _, err := readToken("", path+"-absent"); err == nil {
		t.Fatal("accepted a missing token file")
	}
	if err := os.WriteFile(path, []byte(strings.Repeat("x", 4097)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readToken("", path); err == nil {
		t.Fatal("accepted an unbounded token file")
	}
}

func TestSystemdCredentialWithACLMask(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("CREDENTIALS_DIRECTORY", directory)
	path := filepath.Join(directory, "agent-token")
	if err := os.WriteFile(path, []byte("synthetic-token"), 0440); err != nil {
		t.Fatal(err)
	}
	if token, err := readToken("", path); err != nil || token != "synthetic-token" {
		t.Fatal("did not read the systemd credential file")
	}
	if err := os.Chmod(path, 0444); err != nil {
		t.Fatal(err)
	}
	if _, err := readToken("", path); err == nil {
		t.Fatal("accepted a world-readable credential file")
	}
}
