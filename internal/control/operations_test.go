package control

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/MattoYuzuru/Caudal/internal/operations"
)

type recordingRunner struct {
	specs  []operations.Spec
	mu     sync.Mutex
	calls  []string
	active int
	peak   int
}

func (r *recordingRunner) List() []operations.Spec { return r.specs }

func (r *recordingRunner) Execute(_ context.Context, id string) operations.Result {
	r.mu.Lock()
	r.calls = append(r.calls, id)
	r.active++
	r.peak = max(r.peak, r.active)
	r.mu.Unlock()
	time.Sleep(25 * time.Millisecond)
	r.mu.Lock()
	r.active--
	r.mu.Unlock()
	return operations.Result{Status: "ok", Lines: []string{"Recorded fixture " + id}}
}

func (r *recordingRunner) observed() (int, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls), r.peak
}

func decodeRun(t *testing.T, body []byte) operationRun {
	t.Helper()
	var reply struct{ Run operationRun }
	if err := json.Unmarshal(body, &reply); err != nil || len(reply.Run.ID) != 32 {
		t.Fatalf("missing run: %s (%v)", body, err)
	}
	return reply.Run
}

func TestModelProposalsRequireApprovalForEffectsAndStaySessionBound(t *testing.T) {
	runner := &recordingRunner{specs: []operations.Spec{
		{ID: "fixture-read", Label: "Read", Target: "Fixture", Transport: "http", Method: "GET", Effect: "read"},
		{ID: "fixture-change", Label: "Change", Target: "Fixture", Transport: "http", Method: "PATCH", Effect: "change"},
		{ID: "fixture-delete", Label: "Delete", Target: "Fixture", Transport: "http", Method: "DELETE", Effect: "destructive"},
	}}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		if req.Header.Get("Authorization") != "Bearer provider-fixture" ||
			!bytes.Contains(body, []byte(`"model":"deepseek-v4-pro"`)) ||
			!bytes.Contains(body, []byte(`"reasoning_effort":"high"`)) ||
			!bytes.Contains(body, []byte(planTool)) || bytes.Contains(body, []byte("provider-fixture")) {
			w.WriteHeader(400)
			return
		}
		ids := `{"operation_ids":["fixture-read","fixture-change","fixture-delete"]}`
		if bytes.Contains(body, []byte("unknown fixture")) {
			ids = `{"operation_ids":["unauthorized-target"]}`
		}
		respond(w, 200, map[string]any{"choices": []any{map[string]any{"message": map[string]any{
			"tool_calls": []any{map[string]any{"type": "function", "function": map[string]string{"name": planTool, "arguments": ids}}},
		}}}})
	}))
	defer provider.Close()
	f := start(t, Config{Operations: runner, DeepSeek: DeepSeek{endpoint: provider.URL, client: provider.Client()}})
	cookie := f.login(t)
	anotherSession := f.login(t)
	input := map[string]any{
		"message": "Plan a fixture change", "api_key": "provider-fixture", "mode": "deepseek",
		"model": "deepseek-v4-pro", "effort": "high", "auto_approve_read": true,
	}
	code, _, body, _ := f.send(t, "POST", "/api/v1/assistant", input, nil, cookie)
	expect(t, code, 200, body)
	plan := decodeRun(t, body)
	if plan.Status != "awaiting_approval" || len(plan.Operations) != 3 {
		t.Fatalf("invalid plan: %+v", plan)
	}
	if count, _ := runner.observed(); count != 0 {
		t.Fatal("an action ran before explicit approval")
	}
	base := "/api/v1/runs/" + plan.ID
	code, _, body, _ = f.send(t, "POST", base+"/approve", nil, nil, anotherSession)
	expect(t, code, 404, body)
	code, _, body, _ = f.send(t, "POST", base+"/approve", nil, map[string]string{"Origin": "https://example.invalid"}, cookie)
	expect(t, code, 403, body)
	code, _, body, _ = f.send(t, "POST", base+"/approve", nil, nil, cookie)
	expect(t, code, 200, body)
	completed := decodeRun(t, body)
	if completed.Status != "completed" || len(completed.Results) != 3 || completed.Results[2].Status != "ok" {
		t.Fatalf("missing execution receipt: %+v", completed)
	}
	code, _, body, _ = f.send(t, "GET", base, nil, nil, anotherSession)
	expect(t, code, 404, body)
	code, _, body, _ = f.send(t, "GET", base, nil, nil, cookie)
	expect(t, code, 200, body)
	if stored := decodeRun(t, body); stored.Status != "completed" || len(stored.Results) != 3 {
		t.Fatal("completed receipt was unavailable")
	}
	code, _, body, _ = f.send(t, "POST", base+"/approve", nil, nil, cookie)
	expect(t, code, 200, body)
	if count, peak := runner.observed(); count != 3 || peak != 1 {
		t.Fatalf("duplicate execution or concurrent mutations: count=%d peak=%d", count, peak)
	}
	code, _, body, _ = f.send(t, "POST", "/api/v1/assistant", map[string]string{
		"message": "Что получилось?", "mode": "local", "run_id": plan.ID,
	}, nil, cookie)
	expect(t, code, 200, body)
	if !bytes.Contains(body, []byte("#run-"+plan.ID+"-L3")) {
		t.Fatalf("missing stable receipt link: %s", body)
	}

	code, _, body, _ = f.send(t, "POST", "/api/v1/assistant", input, nil, cookie)
	expect(t, code, 200, body)
	pending := decodeRun(t, body)
	cancelPath := "/api/v1/runs/" + pending.ID
	code, _, body, _ = f.send(t, "POST", cancelPath+"/cancel", nil, nil, cookie)
	expect(t, code, 200, body)
	if run := decodeRun(t, body); run.Status != "cancelled" {
		t.Fatal("operation run did not cancel")
	}
	code, _, body, _ = f.send(t, "POST", cancelPath+"/approve", nil, nil, cookie)
	expect(t, code, 200, body)
	if count, _ := runner.observed(); count != 3 {
		t.Fatal("cancelled operation ran")
	}
	input["message"] = "unknown fixture"
	code, _, body, _ = f.send(t, "POST", "/api/v1/assistant", input, nil, cookie)
	expect(t, code, 422, body)
}

func TestOptedInReadOnlyOperationsRunInParallel(t *testing.T) {
	runner := &recordingRunner{specs: []operations.Spec{
		{ID: "ssh-local-a", Label: "Uptime", Target: "Alpha", Transport: "ssh", Method: "uptime", Effect: "read"},
		{ID: "ssh-local-b", Label: "Uptime", Target: "Beta", Transport: "ssh", Method: "uptime", Effect: "read"},
	}}
	f := start(t, Config{Operations: runner})
	code, _, body, _ := f.send(t, "GET", "/api/v1/operations", nil, nil, nil)
	expect(t, code, 401, body)
	cookie := f.login(t)
	code, _, body, _ = f.send(t, "GET", "/api/v1/operations", nil, nil, cookie)
	expect(t, code, 200, body)
	if !bytes.Contains(body, []byte("ssh-local-a")) || !bytes.Contains(body, []byte("ssh-local-b")) {
		t.Fatalf("catalog lost configured routes: %s", body)
	}
	input := map[string]any{"message": "Проверь SSH на Alpha и Beta", "mode": "local"}
	code, _, body, _ = f.send(t, "POST", "/api/v1/assistant", input, nil, cookie)
	expect(t, code, 200, body)
	if run := decodeRun(t, body); run.Status != "awaiting_approval" {
		t.Fatalf("read auto-approved by default: %+v", run)
	}
	input["auto_approve_read"] = true
	code, _, body, _ = f.send(t, "POST", "/api/v1/assistant", input, nil, cookie)
	expect(t, code, 200, body)
	if run := decodeRun(t, body); run.Status != "completed" || len(run.Results) != 2 {
		t.Fatalf("missing parallel receipt: %+v", run)
	}
	if count, peak := runner.observed(); count != 2 || peak != 2 {
		t.Fatalf("read batch wasn't parallel: count=%d peak=%d", count, peak)
	}
	input["message"] = "Проверь SSH на Unknown"
	code, _, body, _ = f.send(t, "POST", "/api/v1/assistant", input, nil, cookie)
	expect(t, code, 200, body)
	if plan := decodeRun(t, body); plan.Status != "awaiting_approval" {
		t.Fatalf("unmatched targets were executed: %+v", plan)
	}
	if count, _ := runner.observed(); count != 2 {
		t.Fatal("ambiguous local instruction contacted fallback targets")
	}
}

func TestDelayedModelCannotDispatchAfterSessionEnds(t *testing.T) {
	runner := &recordingRunner{specs: []operations.Spec{
		{ID: "fixture-uptime", Label: "Uptime", Target: "Fixture", Transport: "ssh", Effect: "read"},
	}}
	started, answered := make(chan struct{}), make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		close(started)
		select {
		case <-answered:
		case <-request.Context().Done():
			return
		case <-time.After(5 * time.Second):
			return
		}
		respond(w, 200, map[string]any{"choices": []any{map[string]any{"message": map[string]any{
			"tool_calls": []any{map[string]any{"type": "function", "function": map[string]string{
				"name": planTool, "arguments": `{"operation_ids":["fixture-uptime"]}`,
			}}},
		}}}})
	}))
	defer provider.Close()
	f := start(t, Config{Operations: runner, DeepSeek: DeepSeek{endpoint: provider.URL, client: provider.Client()}})
	cookie := f.login(t)
	input := map[string]any{"message": "Please check fixture uptime", "mode": "deepseek", "api_key": "provider-fixture", "auto_approve_read": true}
	status := make(chan int, 1)
	go func() {
		code, _, _, _ := f.send(t, "POST", "/api/v1/assistant", input, nil, cookie)
		status <- code
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("provider request did not start")
	}
	code, _, body, _ := f.send(t, "DELETE", "/api/v1/session", nil, nil, cookie)
	expect(t, code, 204, body)
	close(answered)
	select {
	case code := <-status:
		expect(t, code, 401, nil)
	case <-time.After(2 * time.Second):
		t.Fatal("request did not observe session loss")
	}
	if count, _ := runner.observed(); count != 0 {
		t.Fatal("a revoked session executed an operation")
	}
}

func TestSelectedScopeUsesNodeIDWithDuplicateNames(t *testing.T) {
	runner := &recordingRunner{}
	f := start(t, Config{Operations: runner})
	bound, _, err := f.store.Enroll("Duplicate", "East")
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := f.store.Enroll("Duplicate", "West")
	if err != nil {
		t.Fatal(err)
	}
	runner.specs = []operations.Spec{
		{ID: "fixture-uptime", Label: "Uptime", Target: "Duplicate", NodeID: bound.ID, Transport: "ssh", Effect: "read"},
	}
	cookie := f.login(t)
	input := map[string]string{"message": "Проверь SSH на Duplicate", "mode": "local", "node_id": other.ID}
	code, _, body, _ := f.send(t, "POST", "/api/v1/assistant", input, nil, cookie)
	expect(t, code, 200, body)
	if bytes.Contains(body, []byte("fixture-uptime")) {
		t.Fatal("a different node got a physical route through a duplicate name")
	}
	input["node_id"] = bound.ID
	code, _, body, _ = f.send(t, "POST", "/api/v1/assistant", input, nil, cookie)
	expect(t, code, 200, body)
	if run := decodeRun(t, body); len(run.Operations) != 1 || run.Operations[0].ID != "fixture-uptime" {
		t.Fatalf("the bound node lost its route: %+v", run)
	}
}
