package teleport

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func TestPublicDestination(t *testing.T) {
	for _, address := range []string{"8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"} {
		if !publicAddress(netip.MustParseAddr(address)) {
			t.Errorf("public address denied: %s", address)
		}
	}
	for _, address := range []string{
		"0.0.0.0", "0.1.2.3", "127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1",
		"192.0.0.1", "192.0.2.1", "192.168.0.1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "::", "::1",
		"fd00:ec2::254", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe", "2001:db8::1", "2606:4700::1111%zone",
	} {
		if publicAddress(netip.MustParseAddr(address)) {
			t.Errorf("non-public address accepted: %s", address)
		}
	}
	mixed := []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("127.0.0.1")}
	if conn, err := dialResolved(t.Context(), "tcp", "443", mixed); conn != nil || !errors.Is(err, errNonPublic) {
		t.Fatalf("mixed public and private DNS answers returned %v, %v", conn, err)
	}
	if conn, err := dialResolved(t.Context(), "tcp", "443", nil); conn != nil || networkReason(err) != "dns_error" {
		t.Fatalf("empty DNS answers returned %v, %v", conn, err)
	}
	if _, reason := newProbe()(t.Context(), "https://127.0.0.1"); reason != "non_public_address" {
		t.Fatalf("production transport's private destination result: %q", reason)
	}
}

func TestPingRetainsOnlyTheVersion(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
		want   string
		error  string
	}{
		{"teleport", 200, `{"server_version":"18.7.6","auth":{"private":"synthetic"},"proxy":{},"cluster_name":"private"}`, "18.7.6", ""},
		{"prerelease", 200, `{"server_version":"v18.7.6-rc.1+meta"}`, "v18.7.6-rc.1+meta", ""},
		{"redirect", 307, ``, "", "redirect"},
		{"login", 401, `{"error":{"message":"synthetic"}}`, "", "http_denied"},
		{"denied", 403, ``, "", "http_denied"},
		{"unavailable", 451, ``, "", "http_denied"},
		{"other", 503, ``, "", "http_error"},
		{"wrong_response", 200, `<html>signin</html>`, "", "unexpected_response"},
		{"missing_version", 200, `{"proxy":{}}`, "", "unexpected_response"},
		{"invalid_version", 200, `{"server_version":"javascript:payload"}`, "", "unexpected_response"},
		{"large_response", 200, `{"server_version":"18.7.6","other":"` + strings.Repeat("x", responseLimit) + `"}`, "", "unexpected_response"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.String() != "/webapi/ping" || r.Header.Get("Accept") != "application/json" ||
					r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
					t.Error("probe used an unexpected request method, URL or headers")
				}
				w.Header().Set("Location", "/redirect-must-not-trigger")
				w.WriteHeader(test.status)
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			client := server.Client()
			client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
			if version, reason := ping(t.Context(), client, server.URL); version != test.want || reason != test.error {
				t.Fatalf("version %q, failure %q, wanted %q, %q", version, reason, test.want, test.error)
			}
		})
	}
}

func TestProbeClassifiesTLSAndNetworkFailures(t *testing.T) {
	untrusted := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer untrusted.Close()
	if _, reason := ping(t.Context(), &http.Client{}, untrusted.URL); reason != "tls_certificate" {
		t.Fatalf("untrusted certificate reported %q", reason)
	}
	for _, test := range []struct {
		err  error
		want string
	}{
		{context.DeadlineExceeded, "timeout"},
		{&net.DNSError{Err: "synthetic"}, "dns_error"},
		{io.ErrUnexpectedEOF, "network_error"},
	} {
		if got := networkReason(test.err); got != test.want {
			t.Errorf("networkReason(%v) = %q; want %q", test.err, got, test.want)
		}
	}
}
