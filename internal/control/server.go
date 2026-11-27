package control

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/MattoYuzuru/Caudal/internal/fleet"
	"github.com/MattoYuzuru/Caudal/internal/teleport"
)

const sessionLifetime = 12 * time.Hour

type Config struct {
	Origin             string
	OwnerPassword      string
	MCPToken           string
	WebDir             string
	DownloadDir        string
	BuildVersion       string
	DeepSeek           DeepSeek
	Teleport           *teleport.Registry
	ControlPlaneNodeID string
	Logger             *slog.Logger
}

type Server struct {
	config       Config
	fleet        *fleet.Store
	secure       bool
	password     [sha256.Size]byte
	mcpToken     [sha256.Size]byte
	sessions     map[string]time.Time
	failures     map[string]loginFailures
	authMu       sync.Mutex
	assistant    chan struct{}
	fleetChanges *fleetChanges
	fleetStreams chan struct{}
}

type loginFailures struct {
	count   int
	expires time.Time
}

type fleetView struct {
	Nodes              []fleet.Node `json:"nodes"`
	ControlPlaneNodeID string       `json:"control_plane_node_id,omitempty"`
	ServerTime         time.Time    `json:"server_time"`
}

type samplesView struct {
	Samples []fleet.Sample `json:"samples"`
}

func New(config Config, store *fleet.Store) (http.Handler, error) {
	u, err := url.Parse(config.Origin)
	if err != nil || u.User != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" ||
		u.Fragment != "" || u.ForceQuery ||
		(u.Scheme != "https" && (u.Scheme != "http" || !loopback(u.Hostname()))) {
		return nil, errors.New("CAUDAL_ORIGIN must be an HTTPS origin or loopback HTTP origin")
	}
	if len(config.OwnerPassword) < 24 {
		return nil, errors.New("the owner password must have at least 24 characters")
	}
	if config.MCPToken != "" && (len(config.MCPToken) < 32 || config.MCPToken == config.OwnerPassword) {
		return nil, errors.New("the MCP token must be distinct and have at least 32 characters")
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}
	mcpEnabled := config.MCPToken != ""
	passwordHash := sha256.Sum256([]byte(config.OwnerPassword))
	mcpHash := sha256.Sum256([]byte(config.MCPToken))
	config.OwnerPassword, config.MCPToken = "", ""
	s := &Server{
		config: config, fleet: store, secure: u.Scheme == "https",
		password: passwordHash, mcpToken: mcpHash,
		sessions: make(map[string]time.Time), failures: make(map[string]loginFailures),
		assistant:    make(chan struct{}, 1),
		fleetChanges: &fleetChanges{next: make(chan struct{})},
		fleetStreams: make(chan struct{}, 16),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /api/v1/session", s.session)
	mux.HandleFunc("POST /api/v1/session", s.login)
	mux.HandleFunc("DELETE /api/v1/session", s.logout)
	mux.HandleFunc("GET /api/v1/fleet", s.owner(s.list))
	mux.HandleFunc("GET /api/v1/fleet/events", s.owner(s.streamFleet))
	mux.HandleFunc("POST /api/v1/nodes", s.owner(s.enroll))
	mux.HandleFunc("POST /api/v1/nodes/{id}/rotate", s.owner(s.rotate))
	mux.HandleFunc("GET /api/v1/nodes/{id}/samples", s.owner(s.samples))
	mux.HandleFunc("POST /api/v1/agents/heartbeat", s.heartbeat)
	mux.HandleFunc("POST /api/v1/assistant", s.owner(s.ask))
	mux.HandleFunc("GET /api/v1/assistant/status", s.owner(s.assistantStatus))
	mux.HandleFunc("GET /api/v1/teleport", s.owner(s.teleportProfiles))
	mux.HandleFunc("POST /api/v1/teleport/{id}/check", s.owner(s.checkTeleport))
	if mcpEnabled {
		mux.Handle("/mcp", s.mcp())
	}
	mux.HandleFunc("GET /downloads/{binary}", s.download)
	mux.HandleFunc("/", s.web)
	return s.guard(mux), nil
}

func loopback(host string) bool {
	return host == "localhost" || net.ParseIP(host).IsLoopback()
}

func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if s.secure {
			w.Header().Set("Strict-Transport-Security", "max-age=86400")
		}

		// The network entry points never grant CORS or accept a cross-origin browser.
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/mcp" {
			w.Header().Set("Cache-Control", "no-store")
			origin := r.Header.Get("Origin")
			if (origin != "" && origin != s.config.Origin) ||
				r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				failure(w, 403, "invalid_origin")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	respond(w, http.StatusOK, map[string]string{"status": "ok", "version": s.config.BuildVersion})
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	respond(w, http.StatusOK, map[string]bool{"authenticated": s.authenticated(r)})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Password string `json:"password"`
	}
	if !decode(w, r, &input) {
		return
	}
	ip := s.clientIP(r)
	now := time.Now()
	s.authMu.Lock()
	defer s.authMu.Unlock()
	for address, failed := range s.failures {
		if !now.Before(failed.expires) {
			delete(s.failures, address)
		}
	}
	failed := s.failures[ip]
	if failed.count >= 8 {
		w.Header().Set("Retry-After", "60")
		failure(w, 429, "too_many_attempts")
		return
	}
	if !matches(s.password, input.Password) {
		if len(s.failures) < 1024 || failed.count > 0 {
			if failed.count == 0 {
				failed.expires = now.Add(time.Minute)
			}
			failed.count++
			s.failures[ip] = failed
		}
		failure(w, 401, "invalid_password")
		return
	}
	delete(s.failures, ip)
	for session, expiry := range s.sessions {
		if !now.Before(expiry) {
			delete(s.sessions, session)
		}
	}
	if len(s.sessions) >= 128 {
		failure(w, 429, "too_many_sessions")
		return
	}
	if cookie, err := r.Cookie(s.cookieName()); err == nil {
		delete(s.sessions, cookie.Value)
	}
	key := make([]byte, 32)
	rand.Read(key)
	value := base64.RawURLEncoding.EncodeToString(key)
	s.sessions[value] = now.Add(sessionLifetime)
	http.SetCookie(w, s.cookie(value, int(sessionLifetime.Seconds())))
	respond(w, http.StatusOK, map[string]bool{"authenticated": true})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(s.cookieName()); err == nil {
		s.authMu.Lock()
		delete(s.sessions, cookie.Value)
		s.authMu.Unlock()
	}
	http.SetCookie(w, s.cookie("", -1))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) authenticated(r *http.Request) bool {
	cookie, err := r.Cookie(s.cookieName())
	if err != nil {
		return false
	}
	s.authMu.Lock()
	defer s.authMu.Unlock()
	return time.Now().Before(s.sessions[cookie.Value])
}

func (s *Server) cookieName() string {
	if s.secure {
		return "__Host-caudal_session"
	}
	return "caudal_session"
}

func (s *Server) cookie(value string, seconds int) *http.Cookie {
	return &http.Cookie{Name: s.cookieName(), Value: value, Path: "/", MaxAge: seconds,
		HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteStrictMode}
}

func (s *Server) clientIP(r *http.Request) string {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if s.secure && loopback(host) {
		if proxy := net.ParseIP(r.Header.Get("X-Caudal-Client-IP")); proxy != nil {
			return proxy.String()
		}
	}
	return host
}

func (s *Server) owner(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authenticated(r) {
			failure(w, http.StatusUnauthorized, "authentication_required")
			return
		}
		next(w, r)
	}
}

func (s *Server) list(w http.ResponseWriter, _ *http.Request) {
	respond(w, http.StatusOK, s.fleetView())
}

func (s *Server) fleetView() fleetView {
	nodes := s.fleet.List()
	view := fleetView{Nodes: nodes, ServerTime: time.Now().UTC()}
	for _, node := range nodes {
		if node.ID == s.config.ControlPlaneNodeID {
			view.ControlPlaneNodeID = node.ID
			break
		}
	}
	return view
}

func (s *Server) enroll(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name   string `json:"name"`
		Region string `json:"region"`
	}
	if !decode(w, r, &input) {
		return
	}
	node, token, err := s.fleet.Enroll(input.Name, input.Region)
	if err != nil {
		s.fleetFailure(w, err)
		return
	}
	s.fleetChanges.notify()
	respond(w, http.StatusCreated, struct {
		Node  fleet.Node `json:"node"`
		Token string     `json:"token"`
	}{node, token})
}

func (s *Server) rotate(w http.ResponseWriter, r *http.Request) {
	token, err := s.fleet.Rotate(r.PathValue("id"))
	if err != nil {
		s.fleetFailure(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]string{"token": token})
}

func (s *Server) samples(w http.ResponseWriter, r *http.Request) {
	samples, err := s.fleet.Samples(r.PathValue("id"))
	if err != nil {
		s.fleetFailure(w, err)
		return
	}
	respond(w, http.StatusOK, samplesView{Samples: samples})
}

func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request) {
	credential := bearer(r)
	if len(credential) != 43 {
		failure(w, http.StatusUnauthorized, "invalid_node_token")
		return
	}
	var input struct {
		Metrics fleet.Metrics `json:"metrics"`
	}
	if !decode(w, r, &input) {
		return
	}
	if err := s.fleet.Heartbeat(credential, input.Metrics); err != nil {
		s.fleetFailure(w, err)
		return
	}
	s.fleetChanges.notify()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) fleetFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, fleet.ErrUnknown):
		failure(w, 404, "node_not_found")
	case errors.Is(err, fleet.ErrInvalid):
		failure(w, 400, "invalid_node_data")
	case errors.Is(err, fleet.ErrLimit):
		failure(w, 409, "fleet_limit_reached")
	case errors.Is(err, fleet.ErrCredential):
		failure(w, 401, "invalid_node_token")
	case errors.Is(err, fleet.ErrTooSoon):
		failure(w, 429, "heartbeat_too_soon")
	default:
		s.config.Logger.Error("fleet storage operation failed", "error", err)
		failure(w, 500, "storage_error")
	}
}

func (s *Server) download(w http.ResponseWriter, r *http.Request) {
	binary := r.PathValue("binary")
	if s.config.DownloadDir == "" || (binary != "caudal-agent-linux-amd64" && binary != "caudal-agent-linux-arm64") {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="`+binary+`"`)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "public, max-age=300")
	http.ServeFile(w, r, filepath.Join(s.config.DownloadDir, binary))
}

func (s *Server) web(w http.ResponseWriter, r *http.Request) {
	if s.config.WebDir == "" || strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/mcp" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	if strings.HasPrefix(r.URL.Path, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	var file string
	if r.URL.Path == "/" {
		file = "index.html"
	} else {
		file = strings.TrimPrefix(r.URL.Path, "/")
	}
	if !filepath.IsLocal(file) {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(s.config.WebDir, file)
	if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, path)
}

func bearer(r *http.Request) string {
	scheme, credential, found := strings.Cut(r.Header.Get("Authorization"), " ")
	if !found || !strings.EqualFold(scheme, "Bearer") || strings.ContainsAny(credential, " \t\r\n") {
		return ""
	}
	return credential
}

func matches(expected [sha256.Size]byte, value string) bool {
	actual := sha256.Sum256([]byte(value))
	return subtle.ConstantTimeCompare(expected[:], actual[:]) == 1
}

func decode(w http.ResponseWriter, r *http.Request, out any) bool {
	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType != "application/json" {
		failure(w, 415, "application_json_required")
		return false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(out) != nil || decoder.Decode(new(any)) != io.EOF {
		failure(w, 400, "invalid_json")
		return false
	}
	return true
}

func respond(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func failure(w http.ResponseWriter, code int, reason string) {
	respond(w, code, map[string]string{"error": reason})
}
