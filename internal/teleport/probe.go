package teleport

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"time"
)

const responseLimit = 64 << 10

var (
	versionPattern = regexp.MustCompile(`^v?[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:[-+][0-9A-Za-z.+-]{1,40})?$`)
	errNonPublic   = errors.New("Teleport origin has a non-public address")
	globalIPv6     = netip.MustParsePrefix("2000::/3")
	nonPublic      = []netip.Prefix{
		netip.MustParsePrefix("0.0.0.0/8"),
		netip.MustParsePrefix("100.64.0.0/10"),
		netip.MustParsePrefix("192.0.0.0/24"),
		netip.MustParsePrefix("192.0.2.0/24"),
		netip.MustParsePrefix("192.88.99.0/24"),
		netip.MustParsePrefix("198.18.0.0/15"),
		netip.MustParsePrefix("198.51.100.0/24"),
		netip.MustParsePrefix("203.0.113.0/24"),
		netip.MustParsePrefix("240.0.0.0/4"),
		netip.MustParsePrefix("2001::/32"),
		netip.MustParsePrefix("2001:db8::/32"),
		netip.MustParsePrefix("2002::/16"),
		netip.MustParsePrefix("3fff::/20"),
	}
)

func publicAddress(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsGlobalUnicast() || address.IsPrivate() || address.Zone() != "" || (address.Is6() && !globalIPv6.Contains(address)) {
		return false
	}
	for _, prefix := range nonPublic {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

func dialPublic(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	return dialResolved(ctx, network, port, addresses)
}

func dialResolved(ctx context.Context, network, port string, addresses []netip.Addr) (net.Conn, error) {
	if len(addresses) == 0 {
		return nil, &net.DNSError{Err: "no addresses"}
	}
	// Validate every result and dial numeric addresses to prevent a second DNS resolution.
	for _, candidate := range addresses {
		if !publicAddress(candidate) {
			return nil, errNonPublic
		}
	}
	dialer := &net.Dialer{Timeout: 1500 * time.Millisecond}
	var lastError error
	for _, candidate := range addresses {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(candidate.Unmap().String(), port))
		if err == nil {
			return conn, nil
		}
		lastError = err
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	return nil, lastError
}

func newProbe() func(context.Context, string) (string, string) {
	client := &http.Client{
		Transport: &http.Transport{
			DialContext:            dialPublic,
			ForceAttemptHTTP2:      true,
			TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
			TLSHandshakeTimeout:    3 * time.Second,
			MaxResponseHeaderBytes: 32 << 10,
			DisableKeepAlives:      true,
		},
		Timeout: 6 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return func(ctx context.Context, origin string) (string, string) {
		return ping(ctx, client, origin)
	}
}

func ping(ctx context.Context, client *http.Client, origin string) (version, reason string) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/webapi/ping", nil)
	if err != nil {
		return "", "unexpected_response"
	}
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return "", networkReason(err)
	}
	defer response.Body.Close()
	switch {
	case response.StatusCode >= 300 && response.StatusCode < 400:
		return "", "redirect"
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusUnavailableForLegalReasons:
		return "", "http_denied"
	case response.StatusCode != http.StatusOK:
		return "", "http_error"
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, responseLimit+1))
	if err != nil {
		return "", networkReason(err)
	}
	var result struct {
		Version string `json:"server_version"`
	}
	if len(data) > responseLimit || json.Unmarshal(data, &result) != nil || !versionPattern.MatchString(result.Version) {
		return "", "unexpected_response"
	}
	return result.Version, ""
}

func networkReason(err error) string {
	if errors.Is(err, errNonPublic) {
		return "non_public_address"
	}
	var connErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &connErr) && connErr.Timeout()) {
		return "timeout"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "dns_error"
	}
	var certErr *tls.CertificateVerificationError
	if errors.As(err, &certErr) {
		return "tls_certificate"
	}
	return "network_error"
}
