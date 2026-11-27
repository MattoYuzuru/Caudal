package control

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MattoYuzuru/Caudal/internal/fleet"
	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	ownerPassword = "a long synthetic owner password used by tests"
	mcpCredential = "fixture-MCP-token-of-sufficient-length"
)

type fixture struct {
	server *httptest.Server
	store  *fleet.Store
	now    time.Time
}

func start(t *testing.T, config Config) *fixture {
	t.Helper()
	f := &fixture{server: httptest.NewUnstartedServer(nil), now: time.Now().UTC()}
	t.Cleanup(f.server.Close)
	config.Origin = "http://" + f.server.Listener.Addr().String()
	if config.OwnerPassword == "" {
		config.OwnerPassword = ownerPassword
	}
	config.BuildVersion = "test"
	var err error
	f.store, err = fleet.Open(filepath.Join(t.TempDir(), "fleet"), func() time.Time { return f.now })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.store.Close() })
	f.server.Config.Handler, err = New(config, f.store)
	if err != nil {
		t.Fatal(err)
	}
	f.server.Start()
	return f
}

func (f *fixture) send(t *testing.T, method, path string, data any, headers map[string]string, cookie *http.Cookie) (int, http.Header, []byte, []*http.Cookie) {
	t.Helper()
	var body io.Reader
	if data != nil {
		encoded, err := json.Marshal(data)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, f.server.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	if data != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	content, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, resp.Header, content, resp.Cookies()
}

func (f *fixture) login(t *testing.T) *http.Cookie {
	t.Helper()
	code, headers, body, cookies := f.send(t, "POST", "/api/v1/session", map[string]string{"password": ownerPassword}, nil, nil)
	if code != 200 || headers.Get("Cache-Control") != "no-store" || !bytes.Contains(body, []byte(`"authenticated":true`)) ||
		len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("login failed: status %d, %s", code, body)
	}
	return cookies[0]
}

func expect(t *testing.T, code, want int, body []byte) {
	t.Helper()
	if code != want {
		t.Fatalf("got %d want %d: %s", code, want, body)
	}
}

func TestHTTPFleetAndCredentialIsolation(t *testing.T) {
	f := start(t, Config{MCPToken: mcpCredential})
	code, _, body, _ := f.send(t, "GET", "/api/v1/session", nil, nil, nil)
	expect(t, code, 200, body)
	if !bytes.Contains(body, []byte(`"authenticated":false`)) {
		t.Fatal("unexpected authenticated session")
	}
	code, _, body, _ = f.send(t, "GET", "/api/v1/fleet", nil, map[string]string{"Authorization": "Bearer " + mcpCredential}, nil)
	expect(t, code, 401, body)
	code, _, body, _ = f.send(t, "POST", "/api/v1/session", map[string]string{"password": ownerPassword},
		map[string]string{"Origin": "https://example.invalid"}, nil)
	expect(t, code, 403, body)
	cookie := f.login(t)
	code, _, body, _ = f.send(t, "POST", "/api/v1/nodes", map[string]string{"name": "Node One", "region": "Local"}, nil, cookie)
	expect(t, code, 201, body)
	var enrolled struct {
		Node  fleet.Node
		Token string
	}
	if err := json.Unmarshal(body, &enrolled); err != nil || enrolled.Node.Status != "pending" || len(enrolled.Token) != 43 {
		t.Fatalf("bad enrollment: %v", err)
	}
	validMetrics := map[string]any{"metrics": fleet.Metrics{CPUPercent: 1, MemoryTotal: 1024, DiskTotal: 2048, UptimeSeconds: 30}}
	code, _, body, _ = f.send(t, "POST", "/api/v1/agents/heartbeat", validMetrics, nil, cookie)
	expect(t, code, 401, body)
	code, _, body, _ = f.send(t, "GET", "/api/v1/fleet", nil, map[string]string{"Authorization": "Bearer " + enrolled.Token}, nil)
	expect(t, code, 401, body)
	code, _, body, _ = f.send(t, "POST", "/mcp", nil, map[string]string{"Authorization": "Bearer " + enrolled.Token}, cookie)
	expect(t, code, 401, body)

	nodeHeader := map[string]string{"Authorization": "Bearer " + enrolled.Token}
	code, _, body, _ = f.send(t, "POST", "/api/v1/agents/heartbeat", map[string]any{"metrics": fleet.Metrics{}}, nodeHeader, nil)
	expect(t, code, 400, body)
	code, _, body, _ = f.send(t, "POST", "/api/v1/agents/heartbeat", validMetrics, nodeHeader, nil)
	expect(t, code, 204, body)
	code, _, body, _ = f.send(t, "POST", "/api/v1/agents/heartbeat", validMetrics, nodeHeader, nil)
	expect(t, code, 429, body)
	code, _, body, _ = f.send(t, "GET", "/api/v1/fleet", nil, nil, cookie)
	expect(t, code, 200, body)
	if !bytes.Contains(body, []byte(`"status":"healthy"`)) || bytes.Contains(body, []byte(enrolled.Token)) {
		t.Fatal("fleet status missing or credentials leaked")
	}
	path := "/api/v1/nodes/" + enrolled.Node.ID
	code, _, body, _ = f.send(t, "GET", path+"/samples", nil, nil, cookie)
	expect(t, code, 200, body)
	var history samplesView
	if err := json.Unmarshal(body, &history); err != nil || len(history.Samples) != 1 || history.Samples[0].Metrics.DiskTotal != 2048 {
		t.Fatalf("bad history: %+v (%v)", history, err)
	}
	code, _, body, _ = f.send(t, "POST", path+"/rotate", nil, nil, cookie)
	expect(t, code, 200, body)
	code, _, body, _ = f.send(t, "POST", "/api/v1/agents/heartbeat", validMetrics, nodeHeader, nil)
	expect(t, code, 401, body)
	code, _, body, _ = f.send(t, "GET", "/api/v1/nodes/missing/samples", nil, nil, cookie)
	expect(t, code, 404, body)
	code, _, body, _ = f.send(t, "DELETE", "/api/v1/session", nil, nil, cookie)
	expect(t, code, 204, body)
	code, _, body, _ = f.send(t, "GET", "/api/v1/fleet", nil, nil, cookie)
	expect(t, code, 401, body)
}

func TestLoginLimitsAndMalformedRequests(t *testing.T) {
	f := start(t, Config{})
	for range 8 {
		code, _, body, _ := f.send(t, "POST", "/api/v1/session", map[string]string{"password": "wrong"}, nil, nil)
		expect(t, code, 401, body)
	}
	code, headers, body, _ := f.send(t, "POST", "/api/v1/session", map[string]string{"password": ownerPassword}, nil, nil)
	expect(t, code, 429, body)
	if headers.Get("Retry-After") != "60" {
		t.Fatal("missing Retry-After")
	}
	code, _, body, _ = f.send(t, "POST", "/api/v1/session", nil, nil, nil)
	expect(t, code, 415, body)
	code, _, body, _ = f.send(t, "POST", "/api/v1/session", map[string]string{"unexpected": "value"}, nil, nil)
	expect(t, code, 400, body)
}

type bearerTransport struct{ token string }

func (b bearerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(req)
}

func TestMCPModernAndLegacy(t *testing.T) {
	f := start(t, Config{MCPToken: mcpCredential})
	node, _, err := f.store.Enroll("MCP fixture", "lab")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client := mcpsdk.NewClient(&mcpsdk.Implementation{Name: "caudal-test", Version: "1"}, nil)
	session, err := client.Connect(ctx, &mcpsdk.StreamableClientTransport{
		Endpoint: f.server.URL + "/mcp", HTTPClient: &http.Client{Transport: bearerTransport{mcpCredential}},
		DisableStandaloneSSE: true,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	tools, err := session.ListTools(ctx, nil)
	if err != nil || len(tools.Tools) != 3 {
		t.Fatalf("tools: %+v (%v)", tools, err)
	}
	for _, tool := range tools.Tools {
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
			t.Fatalf("tool lacks read-only declaration: %s", tool.Name)
		}
	}
	result, err := session.CallTool(ctx, &mcpsdk.CallToolParams{
		Name: "caudal_get_node", Arguments: map[string]any{"node_id": node.ID},
	})
	if err != nil || result.IsError || result.StructuredContent == nil {
		t.Fatalf("call: %+v (%v)", result, err)
	}
	result, err = session.CallTool(ctx, &mcpsdk.CallToolParams{
		Name: "caudal_get_samples", Arguments: map[string]any{"node_id": "missing"},
	})
	if err != nil || !result.IsError {
		t.Fatalf("missing node call: %+v (%v)", result, err)
	}

	headers := map[string]string{"Accept": "application/json, text/event-stream", "Authorization": "Bearer " + mcpCredential}
	rpc := map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{
		"protocolVersion": "2025-11-25", "capabilities": map[string]any{}, "clientInfo": map[string]string{"name": "legacy", "version": "1"},
	}}
	code, _, body, _ := f.send(t, "POST", "/mcp", rpc, headers, nil)
	expect(t, code, 200, body)
	if !bytes.Contains(body, []byte("2025-11-25")) {
		t.Fatalf("legacy protocol not negotiated: %s", body)
	}
	headers["MCP-Protocol-Version"] = "2025-11-25"
	rpc = map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{"name": "caudal_list_fleet", "arguments": map[string]any{}}}
	code, _, body, _ = f.send(t, "POST", "/mcp", rpc, headers, nil)
	expect(t, code, 200, body)
	if !bytes.Contains(body, []byte("MCP fixture")) {
		t.Fatalf("legacy call did not see enrolled fleet: %s", body)
	}
}

func TestDeepSeekGroundedEvidenceAndProviderKey(t *testing.T) {
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer user-test-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		data, _ := io.ReadAll(r.Body)
		if !bytes.Contains(data, []byte("Pilot node")) || bytes.Contains(data, []byte("Other node")) ||
			bytes.Contains(data, []byte("user-test-key")) || !bytes.Contains(data, []byte("deepseek-flash")) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		respond(w, 200, map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": "Pilot node is awaiting a report."}}}})
	}))
	defer mock.Close()
	f := start(t, Config{DeepSeek: DeepSeek{client: mock.Client(), endpoint: mock.URL}})
	node, _, err := f.store.Enroll("Pilot node", "lab")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.store.Enroll("Other node", "lab"); err != nil {
		t.Fatal(err)
	}
	cookie := f.login(t)
	input := map[string]string{"message": "What is the host status?", "node_id": node.ID}
	code, _, body, _ := f.send(t, "GET", "/api/v1/assistant/status", nil, nil, cookie)
	expect(t, code, 200, body)
	if !bytes.Contains(body, []byte(`"deepseek_configured":false`)) {
		t.Fatal("unexpected configured-provider status")
	}
	code, _, body, _ = f.send(t, "POST", "/api/v1/assistant", input, nil, cookie)
	expect(t, code, 200, body)
	if !bytes.Contains(body, []byte(`"source":"local"`)) || !bytes.Contains(body, []byte(node.ID)) ||
		bytes.Contains(body, []byte("Other node")) {
		t.Fatalf("local fallback has the wrong source or scope: %s", body)
	}
	input["mode"] = "deepseek"
	code, _, body, _ = f.send(t, "POST", "/api/v1/assistant", input, nil, cookie)
	expect(t, code, 503, body)
	input["api_key"] = "user-test-key"
	code, _, body, _ = f.send(t, "POST", "/api/v1/assistant", input, nil, cookie)
	expect(t, code, 200, body)
	if !bytes.Contains(body, []byte(node.ID)) || !bytes.Contains(body, []byte(`"source":"deepseek"`)) ||
		bytes.Contains(body, []byte(input["api_key"])) || bytes.Contains(body, []byte("Other node")) {
		t.Fatalf("wrong receipt scope: %s", body)
	}
	input["api_key"] = "wrong-key"
	code, _, body, _ = f.send(t, "POST", "/api/v1/assistant", input, nil, cookie)
	expect(t, code, 502, body)
	if !bytes.Contains(body, []byte("deepseek_key_rejected")) || bytes.Contains(body, []byte("wrong-key")) {
		t.Fatalf("unsafe provider failure: %s", body)
	}
	input["message"] = strings.Repeat("x", 2001)
	code, _, body, _ = f.send(t, "POST", "/api/v1/assistant", input, nil, cookie)
	expect(t, code, 400, body)
}

func TestFleetStreamInvalidatesAfterCommittedHeartbeat(t *testing.T) {
	f := start(t, Config{})
	path := "/api/v1/fleet/events"
	code, _, body, _ := f.send(t, "GET", path, nil, nil, nil)
	expect(t, code, 401, body)
	node, token, err := f.store.Enroll("Stream fixture", "")
	if err != nil {
		t.Fatal(err)
	}
	cookie := f.login(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", f.server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(cookie)
	resp, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/event-stream" ||
		resp.Header.Get("Cache-Control") != "no-store, no-transform" {
		t.Fatal("invalid stream response")
	}
	lines := bufio.NewReader(resp.Body)
	readEvent := func() {
		t.Helper()
		for {
			line, err := lines.ReadString('\n')
			if err != nil {
				t.Fatal(err)
			}
			if line == "event: fleet\n" {
				data, _ := lines.ReadString('\n')
				blank, _ := lines.ReadString('\n')
				if data != "data: {}\n" || blank != "\n" {
					t.Fatal("invalid or sensitive event payload")
				}
				return
			}
		}
	}
	readEvent()
	metrics := map[string]any{"metrics": fleet.Metrics{MemoryTotal: 1024, DiskTotal: 2048}}
	headers := map[string]string{"Authorization": "Bearer " + token}
	code, _, body, _ = f.send(t, "POST", "/api/v1/agents/heartbeat", metrics, headers, nil)
	expect(t, code, 204, body)
	readEvent()
	code, _, body, _ = f.send(t, "GET", "/api/v1/fleet", nil, nil, cookie)
	expect(t, code, 200, body)
	if !bytes.Contains(body, []byte(node.ID)) || !bytes.Contains(body, []byte(`"status":"healthy"`)) {
		t.Fatalf("stream preceded state commit: %s", body)
	}
	code, _, body, _ = f.send(t, "DELETE", "/api/v1/session", nil, nil, cookie)
	expect(t, code, 204, body)
	if code, _, body, _ := f.send(t, "GET", path, nil, nil, cookie); code != 401 {
		t.Fatalf("revoked session opened a new stream: %d %s", code, body)
	}
}

func TestTeleportRoutesRequireOwnerAndUseRegisteredIDs(t *testing.T) {
	f := start(t, Config{})
	code, _, body, _ := f.send(t, "GET", "/api/v1/teleport", nil, nil, nil)
	expect(t, code, 401, body)
	cookie := f.login(t)
	code, _, body, _ = f.send(t, "GET", "/api/v1/teleport", nil, nil, cookie)
	expect(t, code, 200, body)
	if !bytes.Contains(body, []byte(`"profiles":[]`)) {
		t.Fatalf("expected an empty registry: %s", body)
	}
	code, _, body, _ = f.send(t, "POST", "/api/v1/teleport/unknown/check", nil, nil, cookie)
	expect(t, code, 404, body)
}

func TestStaticAndHealth(t *testing.T) {
	web, downloads := t.TempDir(), t.TempDir()
	binary := "caudal-agent-linux-amd64"
	if err := os.WriteFile(filepath.Join(web, "index.html"), []byte("Caudal"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(downloads, binary), []byte("test binary"), 0600); err != nil {
		t.Fatal(err)
	}
	f := start(t, Config{WebDir: web, DownloadDir: downloads})
	code, headers, body, _ := f.send(t, "GET", "/", nil, nil, nil)
	expect(t, code, 200, body)
	if !bytes.Contains(body, []byte("Caudal")) || !strings.Contains(headers.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatal("missing static payload or content policy")
	}
	code, headers, body, _ = f.send(t, "GET", "/downloads/"+binary, nil, nil, nil)
	expect(t, code, 200, body)
	if !strings.Contains(headers.Get("Content-Disposition"), binary) || !bytes.Contains(body, []byte("test binary")) {
		t.Fatal("collector download missing")
	}
	code, _, body, _ = f.send(t, "GET", "/downloads/owner-password", nil, nil, nil)
	expect(t, code, 404, body)
	code, _, body, _ = f.send(t, "GET", "/api/v1/unknown", nil, nil, nil)
	expect(t, code, 404, body)
	code, _, body, _ = f.send(t, "GET", "/healthz", nil, nil, nil)
	expect(t, code, 200, body)
}
