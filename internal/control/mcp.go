package control

import (
	"context"
	"net/http"
	"net/url"

	"github.com/MattoYuzuru/Caudal/internal/fleet"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func (s *Server) mcp() http.Handler {
	service := mcp.NewServer(&mcp.Implementation{Name: "caudal", Version: s.config.BuildVersion}, &mcp.ServerOptions{
		SupportedProtocolVersions: []string{"2026-07-28", "2025-11-25"},
		Instructions: "Browse cached telemetry for the owner-approved fleet. Stale telemetry does not establish that a node is down. " +
			"Tools do not connect to hosts or run commands.",
	})
	closedWorld := false
	read := &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &closedWorld}
	mcp.AddTool(service, &mcp.Tool{
		Name: "caudal_list_fleet", Description: "List enrolled nodes, the last collector observation and current freshness.",
		Annotations: read,
	}, func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, fleetView, error) {
		return nil, fleetView{Nodes: s.fleet.List()}, nil
	})

	type nodeInput struct {
		NodeID string `json:"node_id" jsonschema:"Node id returned by caudal_list_fleet"`
	}
	type nodeView struct {
		Node fleet.Node `json:"node"`
	}
	mcp.AddTool(service, &mcp.Tool{
		Name: "caudal_get_node", Description: "Get a single node's last telemetry and freshness.",
		Annotations: read,
	}, func(_ context.Context, _ *mcp.CallToolRequest, input nodeInput) (*mcp.CallToolResult, nodeView, error) {
		node, err := s.fleet.Node(input.NodeID)
		return nil, nodeView{Node: node}, err
	})
	mcp.AddTool(service, &mcp.Tool{
		Name: "caudal_get_samples", Description: "Get up to 120 recent collector observations for one node in chronological order.",
		Annotations: read,
	}, func(_ context.Context, _ *mcp.CallToolRequest, input nodeInput) (*mcp.CallToolResult, samplesView, error) {
		samples, err := s.fleet.Samples(input.NodeID)
		return nil, samplesView{Samples: samples}, err
	})

	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return service },
		&mcp.StreamableHTTPOptions{
			Stateless: true, JSONResponse: true, MaxRequestBodyBytes: 16 << 10,
			// Caddy reaches the app over loopback with the public Host. Enforce
			// that single configured Host in the wrapper instead of the SDK rule.
			DisableLocalhostProtection: true,
		})
	origin, _ := url.Parse(s.config.Origin)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != origin.Host {
			failure(w, http.StatusForbidden, "invalid_host")
			return
		}
		if !matches(s.mcpToken, bearer(r)) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="caudal-mcp"`)
			failure(w, http.StatusUnauthorized, "invalid_mcp_token")
			return
		}
		handler.ServeHTTP(w, r)
	})
}
