// Package operations executes only the fixed operations defined by the Caudal operator.
package operations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	Read        = "read"
	Change      = "change"
	Destructive = "destructive"

	OK      = "ok"
	Failed  = "failed"
	Unknown = "unknown"
)

const (
	maxOperations = 24
	maxConfig     = 32 << 10
	maxBody       = 4 << 10
	runTimeout    = 12 * time.Second
)

type Spec struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Transport string `json:"transport"`
	Target    string `json:"target"`
	Method    string `json:"method"`
	Effect    string `json:"effect"`
	NodeID    string `json:"node_id,omitempty"`
}

type Result struct {
	OperationID string   `json:"operation_id"`
	Status      string   `json:"status"`
	Lines       []string `json:"lines"`
	DurationMS  int64    `json:"duration_ms"`
}

type config struct {
	ID             string          `json:"id"`
	Label          string          `json:"label"`
	Transport      string          `json:"transport"`
	Target         string          `json:"target"`
	Method         string          `json:"method"`
	Body           json.RawMessage `json:"body,omitempty"`
	Host           string          `json:"host"`
	Port           int             `json:"port"`
	Login          string          `json:"login"`
	IdentityFile   string          `json:"identity_file"`
	KnownHostsFile string          `json:"known_hosts_file"`
	Proxy          string          `json:"proxy"`
	Cluster        string          `json:"cluster"`
	NodeID         string          `json:"node_id"`
}

type operation struct {
	spec   Spec
	config config
}

type Registry struct {
	operations map[string]operation
	specs      []Spec
	client     *http.Client
	runCommand func(context.Context, string, []string, []string) ([]byte, error)
	findTSH    func() string
}

var (
	idPattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)
	loginPattern   = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	targetPattern  = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)
	dnsNamePattern = regexp.MustCompile(`^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`)
	nodeIDPattern  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	fleetIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
	filePattern    = regexp.MustCompile(`^/[a-zA-Z0-9/._-]{1,511}$`)
)

// New loads an immutable operator catalog. Missing configuration disables operations.
func New(raw string) (*Registry, error) {
	r := &Registry{operations: make(map[string]operation), client: newHTTPClient(), runCommand: runDiagnostic, findTSH: tshBinary}
	if len(raw) > maxConfig {
		return nil, errors.New("operation configuration exceeds 32 KiB")
	}
	if strings.TrimSpace(raw) == "" {
		return r, nil
	}
	var entries []config
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&entries); err != nil || entries == nil || decoder.Decode(new(any)) != io.EOF || len(entries) > maxOperations {
		return nil, errors.New("expected a JSON array with up to 24 configured operations")
	}
	for index, config := range entries {
		spec, err := config.validate()
		if err != nil {
			return nil, fmt.Errorf("operation %d: %w", index+1, err)
		}
		if _, exists := r.operations[spec.ID]; exists {
			return nil, fmt.Errorf("operation %d: duplicate ID", index+1)
		}
		r.operations[spec.ID] = operation{spec: spec, config: config}
		r.specs = append(r.specs, spec)
	}
	return r, nil
}

func (c config) validate() (Spec, error) {
	label := strings.TrimSpace(c.Label)
	if !idPattern.MatchString(c.ID) || label == "" || utf8.RuneCountInString(label) > 64 || strings.ContainsFunc(label, unicode.IsControl) ||
		(c.NodeID != "" && !fleetIDPattern.MatchString(c.NodeID)) {
		return Spec{}, errors.New("invalid ID or label")
	}
	spec := Spec{ID: c.ID, Label: label, Transport: c.Transport, Target: c.Target, NodeID: c.NodeID}
	switch c.Transport {
	case "http":
		if !validURL(c.Target) || c.Host != "" || c.Port != 0 || c.Login != "" || c.IdentityFile != "" ||
			c.KnownHostsFile != "" || c.Proxy != "" || c.Cluster != "" || len(c.Body) > maxBody {
			return Spec{}, errors.New("HTTP requires an exact public HTTPS URL and at most 4 KiB of static JSON")
		}
		spec.Method = c.Method
		switch c.Method {
		case http.MethodGet, http.MethodHead:
			if len(c.Body) != 0 {
				return Spec{}, errors.New("GET and HEAD cannot include a request body")
			}
			spec.Effect = Read
		case http.MethodPost, http.MethodPut, http.MethodPatch:
			spec.Effect = Change
		case http.MethodDelete:
			spec.Effect = Destructive
		default:
			return Spec{}, errors.New("HTTP method must be GET, HEAD, POST, PUT, PATCH or DELETE")
		}
	case "ssh", "tsh":
		if !loginPattern.MatchString(c.Login) || c.Login == "root" || !validPath(c.IdentityFile) ||
			(c.Method != "" && c.Method != "uptime") || len(c.Body) != 0 {
			return Spec{}, errors.New("SSH diagnostics require a dedicated identity and non-root login")
		}
		if c.Transport == "ssh" {
			if !targetPattern.MatchString(c.Target) || !validHost(c.Host) || c.Port < 1 || c.Port > 65535 ||
				!validPath(c.KnownHostsFile) || c.Proxy != "" || c.Cluster != "" {
				return Spec{}, errors.New("SSH requires an exact alias, host, port and pinned known_hosts file")
			}
		} else if !nodeIDPattern.MatchString(c.Target) || !targetPattern.MatchString(c.Cluster) || !validProxy(c.Proxy) ||
			c.Host != "" || c.Port != 0 || c.KnownHostsFile != "" {
			return Spec{}, errors.New("tsh requires an exact node UUID, Teleport cluster and proxy host:port")
		}
		spec.Method, spec.Effect = "uptime", Read
	default:
		return Spec{}, errors.New("unknown operation transport")
	}
	return spec, nil
}

func validPath(path string) bool {
	return filePattern.MatchString(path) && path == filepath.Clean(path)
}

func validHost(host string) bool {
	if ip, err := netip.ParseAddr(host); err == nil {
		return ip.Zone() == "" && !ip.IsUnspecified() && !ip.IsMulticast()
	}
	return len(host) <= 253 && dnsNamePattern.MatchString(host)
}

func validProxy(proxy string) bool {
	host, port, err := net.SplitHostPort(proxy)
	return err == nil && validHost(host) && validPort(port)
}

func validPort(port string) bool {
	n, err := strconv.ParseUint(port, 10, 16)
	return err == nil && n > 0 && port == strconv.FormatUint(n, 10)
}

func validURL(raw string) bool {
	if len(raw) > 1024 || strings.ContainsAny(raw, "?#") {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || !validHost(u.Hostname()) || u.User != nil || strings.HasSuffix(u.Host, ":") ||
		(u.Port() != "" && !validPort(u.Port())) || strings.ContainsFunc(u.Path, unicode.IsControl) {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if ip, err := netip.ParseAddr(host); err == nil {
		return publicAddress(ip)
	}
	if !strings.Contains(host, ".") {
		return false
	}
	for _, suffix := range []string{".localhost", ".local", ".internal", ".home.arpa", ".test", ".invalid", ".onion"} {
		if strings.HasSuffix(host, suffix) {
			return false
		}
	}
	return true
}

func (r *Registry) List() []Spec {
	return append(make([]Spec, 0, len(r.specs)), r.specs...)
}

// Execute accepts only a catalog ID. The caller must enforce the approval state transition.
func (r *Registry) Execute(ctx context.Context, id string) Result {
	result := Result{Status: Failed, Lines: []string{"Operation not configured."}}
	op, exists := r.operations[id]
	if !exists {
		return result
	}
	result.OperationID = op.spec.ID
	if ctx.Err() != nil {
		result.Lines = []string{"Operation canceled before dispatch."}
		return result
	}
	start := time.Now()
	ctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	if op.spec.Transport == "http" {
		result.Status, result.Lines = r.executeHTTP(ctx, op)
	} else {
		result.Status, result.Lines = r.executeSSH(ctx, op)
	}
	result.DurationMS = time.Since(start).Milliseconds()
	return result
}
