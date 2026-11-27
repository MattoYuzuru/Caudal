//go:build linux

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRunnerReportsAndShutsDown(t *testing.T) {
	reports := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
		select {
		case reports <- struct{}{}:
		default:
		}
	}))
	defer server.Close()
	t.Setenv("CAUDAL_URL", server.URL)
	t.Setenv("CAUDAL_TOKEN", "synthetic-token")
	t.Setenv("CAUDAL_TOKEN_FILE", "")
	t.Setenv("CAUDAL_INTERVAL", "")
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- run(ctx) }()
	select {
	case <-reports:
	case err := <-done:
		t.Fatalf("runner quit before its first report: %v", err)
	case <-ctx.Done():
		t.Fatal("runner timed out before its first report")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("runner did not stop after cancellation")
	}
}
