package teleport

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const configured = `[{"id":"edge","label":"Teleport edge","web_url":"https://teleport.example.com:3080"}]`

func TestRegistryConfiguration(t *testing.T) {
	for _, raw := range []string{"", "[]"} {
		registry, err := New(raw)
		if err != nil {
			t.Fatal(err)
		}
		if out, err := json.Marshal(registry.List()); err != nil || string(out) != "[]" {
			t.Fatalf("empty list = %s, %v", out, err)
		}
	}
	registry, err := New(`[
		{"id":"second","label":"  Китай  ","web_url":"https://TELEPORT.Example.com.:03080/"},
		{"id":"first","label":"Proxy","web_url":"https://[2606:4700::1111]"}]`)
	if err != nil {
		t.Fatal(err)
	}
	profiles := registry.List()
	if len(profiles) != 2 || profiles[0] != (Profile{ID: "second", Label: "Китай", WebURL: "https://teleport.example.com:3080", Status: NotChecked}) || profiles[1].WebURL != "https://[2606:4700::1111]" {
		t.Fatalf("unexpected configured profiles: %+v", profiles)
	}
	if _, err := registry.Check(t.Context(), "unknown"); !errors.Is(err, ErrUnknown) {
		t.Fatalf("unknown profile returned %v", err)
	}
	for _, raw := range []string{
		`null`, `{}`, `[] true`, `[{"id":"edge","label":"Edge","web_url":"https://teleport.example.com","token":"synthetic"}]`,
		`[{"id":"edge","label":"Edge","web_url":"http://teleport.example.com"}]`,
		`[{"id":"edge","label":"Edge","web_url":"https://example.com/?token=synthetic"}]`,
		`[{"id":"edge","label":"Edge","web_url":"https://user:synthetic@example.com"}]`,
		`[{"id":"edge","label":"Edge","web_url":"https://example.com/app"}]`,
		`[{"id":"edge","label":"Edge","web_url":"https://example.com/#synthetic"}]`,
		`[{"id":"edge","label":"Edge","web_url":"https://example.com:0"}]`,
		`[{"id":"edge","label":"Edge","web_url":"https://example.com:65536"}]`,
		`[{"id":"edge","label":"Edge","web_url":"https://example.com:"}]`,
		`[{"id":"edge","label":"Edge","web_url":"https://127.0.0.1"}]`,
		`[{"id":"edge","label":"Edge","web_url":"https://[::1]"}]`,
		`[{"id":"edge","label":"Edge","web_url":"https://teleport.local"}]`,
		`[{"id":"edge","label":" \n ","web_url":"https://teleport.example.com"}]`,
		`[{"id":"edge","label":"two\nlines","web_url":"https://teleport.example.com"}]`,
		`[{"id":"bad id","label":"Edge","web_url":"https://teleport.example.com"}]`,
		`[` + strings.Repeat(configured[1:len(configured)-1]+`,`, 8) + configured[1:],
		`[` + configured[1:len(configured)-1] + `,` + configured[1:],
		strings.Repeat(`a`, 9<<10),
	} {
		if _, err := New(raw); err == nil || strings.Contains(err.Error(), "synthetic") {
			t.Errorf("invalid configuration returned %v", err)
		}
	}
}

func TestChecksAreDeduplicatedAndCached(t *testing.T) {
	registry, err := New(configured)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	registry.probe = func(_ context.Context, origin string) (string, string) {
		if origin != "https://teleport.example.com:3080" {
			t.Errorf("probe origin = %q", origin)
		}
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		return "18.10.0", ""
	}
	type result struct {
		profile Profile
		err     error
	}
	results := make(chan result, 8)
	for range cap(results) {
		go func() {
			profile, err := registry.Check(t.Context(), "edge")
			results <- result{profile, err}
		}()
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("no check started")
	}
	if p := registry.List()[0]; p.Status != NotChecked || !p.CheckedAt.IsZero() {
		t.Fatalf("unfinished check changed the last observation: %+v", p)
	}
	close(release)
	for range cap(results) {
		select {
		case observation := <-results:
			if p := observation.profile; observation.err != nil || p.Status != Reachable || p.Version != "18.10.0" || p.CheckedAt.IsZero() {
				t.Fatalf("unexpected profile: %+v, %v", p, observation.err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("check did not finish")
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("eight callers started %d probes", calls.Load())
	}
	registry.entries["edge"].profile.CheckedAt = time.Now().Add(-cooldown)
	registry.probe = func(context.Context, string) (string, string) { return "", "timeout" }
	profile, err := registry.Check(t.Context(), "edge")
	if err != nil || profile.Status != Unreachable || profile.Version != "" || profile.Error != "timeout" {
		t.Fatalf("failed check status: %+v, %v", profile, err)
	}
}

func TestCanceledProbeDoesNotOverwriteObservation(t *testing.T) {
	registry, err := New(configured)
	if err != nil {
		t.Fatal(err)
	}
	previous := registry.entries["edge"].profile
	previous.CheckedAt = time.Now().Add(-cooldown)
	previous.Status, previous.Version = Reachable, "18.10.0"
	registry.entries["edge"].profile = previous
	started := make(chan struct{})
	registry.probe = func(ctx context.Context, _ string) (string, string) {
		close(started)
		<-ctx.Done()
		return "", "timeout"
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := registry.Check(ctx, "edge")
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("no check started")
	}
	waitCtx, stop := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer stop()
	if _, err := registry.Check(waitCtx, "edge"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second caller cancellation: %v", err)
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("caller cancellation: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled check did not stop")
	}
	if profile := registry.List()[0]; profile != previous {
		t.Fatalf("canceled check changed the last observation: %+v", profile)
	}
}
