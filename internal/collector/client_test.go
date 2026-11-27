package collector

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHeartbeatContract(t *testing.T) {
	const token = "synthetic-agent-token"
	metrics := Metrics{CPUPercent: 27.5, MemoryUsedBytes: 50, MemoryTotalBytes: 100, DiskUsedBytes: 40, DiskTotalBytes: 100, UptimeSeconds: 1000}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/agents/heartbeat" ||
			r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Content-Type") != "application/json" {
			t.Error("unexpected heartbeat method, path or headers")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var payload map[string]map[string]float64
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		readings := payload["metrics"]
		want := map[string]float64{
			"cpu_percent": 27.5, "memory_used_bytes": 50, "memory_total_bytes": 100,
			"disk_used_bytes": 40, "disk_total_bytes": 100, "uptime_seconds": 1000,
		}
		if len(payload) != 1 || len(readings) != len(want) {
			t.Errorf("unexpected heartbeat shape: %v", payload)
		}
		for key, value := range want {
			if readings[key] != value {
				t.Errorf("%s = %g, want %g", key, readings[key], value)
			}
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client, err := NewClient(server.URL+"/", token)
	if err != nil {
		t.Fatal(err)
	}
	client.http.Transport = server.Client().Transport
	if err := client.Send(t.Context(), metrics); err != nil {
		t.Fatal(err)
	}
}

func TestHeartbeatDoesNotFollowRedirectsOrIngestResponseBodies(t *testing.T) {
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("heartbeat followed a redirect")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer sink.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", sink.URL)
		w.WriteHeader(http.StatusTemporaryRedirect)
		_, _ = w.Write([]byte("unexpected upstream response content"))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "synthetic-token")
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Send(t.Context(), Metrics{}); err == nil || err.Error() != "heartbeat rejected (HTTP 307)" {
		t.Fatalf("redirect returned %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := client.Send(ctx, Metrics{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled heartbeat returned %v", err)
	}
}

func TestAgentDestinationValidation(t *testing.T) {
	for _, value := range []string{
		"https://example.com", "http://127.0.0.1:8080", "http://[::1]:8080/",
	} {
		if _, err := NewClient(value, "test-token"); err != nil {
			t.Errorf("NewClient rejected %q: %v", value, err)
		}
	}
	for _, value := range []string{
		"http://example.com", "https://example.com/subpath", "https://example.com/?param=secret",
		"https://user:secret@example.com", "https://example.com/#secret", "example.com", "://secret",
	} {
		if _, err := NewClient(value, "test-token"); err == nil || strings.Contains(err.Error(), "secret") {
			t.Errorf("NewClient must reject and redact the input, returned %v", err)
		}
	}
	if _, err := NewClient("https://example.com", "two tokens"); err == nil {
		t.Fatal("accepted an invalid token")
	}
}
