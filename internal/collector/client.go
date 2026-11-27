package collector

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const heartbeatPath = "/api/v1/agents/heartbeat"

// Client delivers host observations to one control plane.
type Client struct {
	endpoint string
	token    string
	http     *http.Client
}

func NewClient(rawOrigin, token string) (*Client, error) {
	if token == "" || strings.IndexFunc(token, func(r rune) bool { return r < 33 || r > 126 }) >= 0 {
		return nil, errors.New("configure a valid Caudal agent token")
	}
	origin, err := url.Parse(rawOrigin)
	if err != nil || origin.Hostname() == "" || origin.User != nil ||
		(origin.Path != "" && origin.Path != "/") || strings.ContainsAny(rawOrigin, "?#") {
		return nil, errors.New("CAUDAL_URL must be an origin, such as https://vps.example.com")
	}
	localHTTP := origin.Scheme == "http" && net.ParseIP(origin.Hostname()).IsLoopback()
	if origin.Scheme != "https" && !localHTTP {
		return nil, errors.New("CAUDAL_URL requires HTTPS or a loopback IP address for local HTTP")
	}
	origin.Path = heartbeatPath
	origin.RawPath = ""
	return &Client{
		endpoint: origin.String(),
		token:    token,
		http: &http.Client{
			Timeout: 8 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func (c *Client) Send(ctx context.Context, metrics Metrics) error {
	payload := struct {
		Metrics Metrics `json:"metrics"`
	}{Metrics: metrics}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode heartbeat: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("prepare heartbeat: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("send heartbeat: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return fmt.Errorf("heartbeat rejected (HTTP %d)", response.StatusCode)
	}
	return nil
}
