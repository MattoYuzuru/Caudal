package operations

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

const (
	endpoint = "https://service.example.com/control/status"
	nodeUUID = "12345678-1234-4321-9012-123456789abc"
)

func configured(t *testing.T, configs ...config) *Registry {
	t.Helper()
	raw, err := json.Marshal(configs)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := New(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func TestCatalogSeparatesPublicMetadataFromExecutionConfig(t *testing.T) {
	var configs []config
	verbs := []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete}
	for _, method := range verbs {
		configs = append(configs, config{ID: strings.ToLower(method), Label: method, Transport: "http", Target: endpoint, Method: method})
	}
	configs[2].Body = json.RawMessage(`{"fixed":"synthetic-private-payload"}`)
	configs = append(configs,
		config{ID: "ssh", Label: "SSH", Transport: "ssh", Target: "node", Host: "127.0.0.1", Port: 22,
			Login: "caudal_observer", IdentityFile: "/private/synthetic-key", KnownHostsFile: "/private/pin"},
		config{ID: "tsh", Label: "Teleport", Transport: "tsh", Target: nodeUUID, Login: "observer",
			IdentityFile: "/private/tsh-identity", Cluster: "cluster-a", Proxy: "teleport.example.com:443"},
	)
	registry := configured(t, configs...)
	specs := registry.List()
	want := []string{Read, Read, Change, Change, Change, Destructive, Read, Read}
	for index, spec := range specs {
		if spec.Effect != want[index] || spec.ID != configs[index].ID || spec.Target != configs[index].Target {
			t.Errorf("wrong public metadata: %+v", spec)
		}
	}
	wire, err := json.Marshal(specs)
	if err != nil || strings.Contains(string(wire), "synthetic") || strings.Contains(string(wire), "127.0.0.1") || strings.Contains(string(wire), "teleport.example.com") {
		t.Fatal("execution config appeared in the public catalog")
	}
	specs[0].Target = "mutable"
	if registry.List()[0].Target != endpoint {
		t.Fatal("mutating returned specs changed the catalog")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if result := registry.Execute(ctx, "post"); result.Status != Failed || result.OperationID != "post" {
		t.Fatalf("pre-dispatch cancellation: %+v", result)
	}
}

func TestOperatorConfigurationFailsClosed(t *testing.T) {
	for _, raw := range []string{"", "[]"} {
		r, err := New(raw)
		if err != nil || r.List() == nil || len(r.List()) != 0 || r.Execute(t.Context(), "arbitrary").Status != Failed {
			t.Fatal("unconfigured operations did not fail closed")
		}
	}
	for _, raw := range []string{
		`null`, `{}`, `[] true`, strings.Repeat(" ", 1) + strings.Repeat("x", maxConfig), `[` + strings.Repeat(`{},`, maxOperations) + `{}]`,
		`[{"id":"x","label":"None","transport":"unsupported"}]`,
		`[{"id":"-x","label":"None","transport":"http"}]`,
		`[{"id":"x","label":"Line\nbreak","transport":"http"}]`,
		`[{"id":"x","label":"URL","transport":"http","target":"http://example.com","method":"GET"}]`,
		`[{"id":"x","label":"URL","transport":"http","target":"https://localhost.local/","method":"GET"}]`,
		`[{"id":"x","label":"URL","transport":"http","target":"https://[::ffff:127.0.0.1]/","method":"GET"}]`,
		`[{"id":"x","label":"URL","transport":"http","target":"https://user:synthetic-secret@example.com/","method":"GET"}]`,
		`[{"id":"x","label":"URL","transport":"http","target":"https://example.com/path?key=synthetic-secret","method":"GET"}]`,
		`[{"id":"x","label":"Port","transport":"http","target":"https://example.com:0/","method":"GET"}]`,
		`[{"id":"x","label":"Port","transport":"http","target":"https://example.com:/","method":"GET"}]`,
		`[{"id":"x","label":"Port","transport":"http","target":"https://example.com:65536/","method":"GET"}]`,
		`[{"id":"x","label":"Path","transport":"http","target":"https://example.com/%00","method":"GET"}]`,
		`[{"id":"x","label":"Payload","transport":"http","target":"https://example.com/","method":"GET","body":{"fixed":true}}]`,
		`[{"id":"x","label":"Payload","transport":"http","target":"https://example.com/","method":"POST","body":"` + strings.Repeat("x", maxBody) + `"}]`,
		`[{"id":"x","label":"Headers","transport":"http","target":"https://example.com/","method":"GET","headers":{"Authorization":"synthetic-secret"}}]`,
		`[{"id":"x","label":"Method","transport":"http","target":"https://example.com/","method":"CONNECT"}]`,
		`[{"id":"x","label":"Port","transport":"ssh","target":"node","login":"observer","identity_file":"/secret/id","known_hosts_file":"/secret/pin","host":"127.0.0.1"}]`,
		`[{"id":"x","label":"Root","transport":"ssh","login":"root","identity_file":"/secret/id","target":"node"}]`,
		`[{"id":"x","label":"Path","transport":"ssh","login":"observer","identity_file":"/secret/../id","target":"node"}]`,
		`[{"id":"x","label":"Command","transport":"ssh","login":"observer","identity_file":"/id","target":"node","method":"hostname"}]`,
		`[{"id":"x","label":"Selection","transport":"tsh","target":"some-name","login":"observer","identity_file":"/id","cluster":"test","proxy":"teleport.example.com:443"}]`,
		`[{"id":"x","label":"Proxy","transport":"tsh","target":"` + nodeUUID + `","login":"observer","identity_file":"/id","cluster":"test","proxy":"teleport.example.com"}]`,
		`[{"id":"x","label":"Duplicate","transport":"http","target":"https://example.com/","method":"GET"},{"id":"x","label":"Another","transport":"http","target":"https://example.com/","method":"GET"}]`,
	} {
		if _, err := New(raw); err == nil || strings.Contains(err.Error(), "synthetic-secret") {
			t.Fatalf("bad operation config returned %v", err)
		}
	}
}
