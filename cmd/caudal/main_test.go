package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCredentialAndLocalDotenv(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.env")
	t.Setenv("CAUDAL_TEST_SECRET", "fixture value")
	t.Setenv("CAUDAL_TEST_SECRET_FILE", path)
	if err := os.WriteFile(path, []byte("fixture-only\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if value, err := credential("CAUDAL_TEST_SECRET"); err != nil || value != "fixture-only" {
		t.Fatalf("file credential: %v", err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := credential("CAUDAL_TEST_SECRET"); err == nil {
		t.Fatal("read public credential file")
	}
	t.Setenv("CAUDAL_TEST_SECRET_FILE", "")
	if value, err := credential("CAUDAL_TEST_SECRET"); err != nil || value != "fixture value" {
		t.Fatalf("environment credential: %v", err)
	}
	if err := os.WriteFile(path, []byte("UNRELATED=fixture\nDEEPSEEK_API_KEY=\"fixture-only\"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if value, err := dotenvKey(path); err != nil || value != "fixture-only" {
		t.Fatalf("dotenv failed: %v", err)
	}
}

func TestRunStartsAndShutsDown(t *testing.T) {
	t.Setenv("CAUDAL_LISTEN", "127.0.0.1:0")
	t.Setenv("CAUDAL_ORIGIN", "http://127.0.0.1:8080")
	t.Setenv("CAUDAL_DATA_DIR", filepath.Join(t.TempDir(), "fleet"))
	t.Setenv("CAUDAL_OWNER_PASSWORD", "test-only password of sufficient length")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := run(ctx); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CAUDAL_LISTEN", "0.0.0.0:8080")
	if err := run(ctx); err == nil {
		t.Fatal("unexpected bind to all interfaces")
	}
}
