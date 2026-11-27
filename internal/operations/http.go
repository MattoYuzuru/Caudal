package operations

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"time"
)

var (
	globalIPv6          = netip.MustParsePrefix("2000::/3")
	specialUseAddresses = []netip.Prefix{
		netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
		netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
		netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("198.18.0.0/15"),
		netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
		netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001::/23"),
		netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"),
		netip.MustParsePrefix("3fff::/20"),
	}
	errNonPublic = errors.New("operation HTTPS target does not resolve to exclusively public addresses")
)

func publicAddress(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsGlobalUnicast() || address.IsPrivate() || address.Zone() != "" || (address.Is6() && !globalIPv6.Contains(address)) {
		return false
	}
	for _, prefix := range specialUseAddresses {
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
	if err := checkResolved(addresses); err != nil {
		return nil, err
	}
	// TLS still verifies the requested origin. Numeric dialing avoids a second DNS lookup.
	dialer := net.Dialer{Timeout: time.Second}
	for _, ip := range addresses {
		conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(ip.Unmap().String(), port))
		if dialErr == nil {
			return conn, nil
		}
		err = dialErr
		if ctx.Err() != nil {
			break
		}
	}
	return nil, err
}

func checkResolved(addresses []netip.Addr) error {
	if len(addresses) == 0 {
		return errNonPublic
	}
	for _, address := range addresses {
		if !publicAddress(address) {
			return errNonPublic
		}
	}
	return nil
}

func newHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 8 * time.Second,
		Transport: &http.Transport{
			DialContext:            dialPublic,
			TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
			TLSHandshakeTimeout:    3 * time.Second,
			MaxResponseHeaderBytes: 16 << 10,
			DisableCompression:     true,
			DisableKeepAlives:      true,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func (r *Registry) executeHTTP(ctx context.Context, op operation) (string, []string) {
	req, err := http.NewRequestWithContext(ctx, op.spec.Method, op.spec.Target, bytes.NewReader(op.config.Body))
	if err != nil {
		return Failed, []string{"Invalid HTTP request configuration."}
	}
	if len(op.config.Body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := r.client.Do(req)
	if err != nil {
		if errors.Is(err, errNonPublic) {
			return Failed, []string{"HTTP destination resolves to a non-public address."}
		}
		if op.spec.Effect != Read {
			return Unknown, []string{"HTTP response unavailable. The remote change could have taken effect."}
		}
		return Failed, []string{"HTTP response unavailable."}
	}
	defer resp.Body.Close()
	lines := []string{fmt.Sprintf("HTTP %d", resp.StatusCode)}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return OK, lines
	}
	if op.spec.Effect != Read && (resp.StatusCode >= 500 || (resp.StatusCode >= 300 && resp.StatusCode < 400)) {
		return Unknown, lines
	}
	return Failed, lines
}
