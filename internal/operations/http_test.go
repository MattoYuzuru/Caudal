package operations

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestConfiguredHTTPUsesOnlyFrozenMethodTargetAndPayload(t *testing.T) {
	const payload = `{"mode":"configured"}`
	for _, tc := range []struct {
		code int
		want string
	}{{http.StatusAccepted, OK}, {http.StatusForbidden, Failed}, {http.StatusInternalServerError, Unknown}, {http.StatusSeeOther, Unknown}} {
		var requests int
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if req.Method != http.MethodPatch || req.URL.RequestURI() != "/control/status" || req.Header.Get("Authorization") != "" ||
				req.Header.Get("Cookie") != "" || req.Header.Get("Content-Type") != "application/json" {
				t.Error("unexpected HTTP operation request")
			}
			body, err := io.ReadAll(req.Body)
			if err != nil || string(body) != payload {
				t.Error("configured payload was not sent verbatim")
			}
			w.Header().Set("Location", "https://somewhere.example.com/redirect")
			w.WriteHeader(tc.code)
			_, _ = io.WriteString(w, `{"secret":"never retain an upstream response body"}`)
		}))
		registry := configured(t, config{ID: "fixed", Label: "Fixed", Transport: "http", Target: endpoint,
			Method: http.MethodPatch, Body: json.RawMessage(payload)})
		registry.client.Transport = transportFunc(func(req *http.Request) (*http.Response, error) {
			requests++
			if req.URL.String() != endpoint {
				t.Error("a redirect or unconfigured URL reached the transport")
				return nil, errors.New("unexpected destination")
			}
			request := req.Clone(req.Context())
			request.URL.Host = server.Listener.Addr().String()
			return server.Client().Transport.RoundTrip(request)
		})
		result := registry.Execute(t.Context(), "fixed")
		server.Close()
		if result.Status != tc.want || requests != 1 || len(result.Lines) != 1 || !strings.HasPrefix(result.Lines[0], "HTTP ") {
			t.Fatalf("result for %d = %+v, requests = %d", tc.code, result, requests)
		}
	}
}

func TestHTTPUncertainDeliveryAndPublicNetworkBoundary(t *testing.T) {
	for _, address := range []string{"0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "100.64.1.3", "198.18.0.2", "2001:db8::1", "::1", "fc00::1", "::ffff:192.168.0.1"} {
		if publicAddress(netip.MustParseAddr(address)) {
			t.Errorf("non-public IP considered public: %s", address)
		}
	}
	public := netip.MustParseAddr("8.8.8.8")
	if !publicAddress(public) || !publicAddress(netip.MustParseAddr("2606:4700::1111")) {
		t.Fatal("public addresses were rejected")
	}
	if err := checkResolved([]netip.Addr{public, netip.MustParseAddr("127.0.0.1")}); !errors.Is(err, errNonPublic) {
		t.Fatal("mixed DNS responses were accepted")
	}
	if err := checkResolved(nil); !errors.Is(err, errNonPublic) {
		t.Fatal("empty DNS result was accepted")
	}
	if conn, err := dialPublic(t.Context(), "tcp", "127.0.0.1:443"); conn != nil || !errors.Is(err, errNonPublic) {
		t.Fatal("production transport dialed the loopback address")
	}
	registry := configured(t,
		config{ID: "read", Label: "Read", Transport: "http", Target: endpoint, Method: http.MethodGet},
		config{ID: "write", Label: "Write", Transport: "http", Target: endpoint, Method: http.MethodDelete},
	)
	registry.client.Transport = transportFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("private upstream diagnostic")
	})
	read := registry.Execute(t.Context(), "read")
	write := registry.Execute(t.Context(), "write")
	if read.Status != Failed || write.Status != Unknown || strings.Contains(strings.Join(write.Lines, ""), "private upstream") {
		t.Fatalf("read = %+v, write = %+v", read, write)
	}
	registry.client.Transport = transportFunc(func(*http.Request) (*http.Response, error) { return nil, errNonPublic })
	if result := registry.Execute(t.Context(), "write"); result.Status != Failed {
		t.Fatalf("non-public denial should never be an uncertain write: %+v", result)
	}
}
