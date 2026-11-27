package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/MattoYuzuru/Caudal/internal/control"
	"github.com/MattoYuzuru/Caudal/internal/fleet"
	"github.com/MattoYuzuru/Caudal/internal/operations"
	"github.com/MattoYuzuru/Caudal/internal/teleport"
)

var version = "development"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx); err != nil {
		slog.Error("Caudal stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	listen := environment("CAUDAL_LISTEN", "127.0.0.1:8080")
	host, _, err := net.SplitHostPort(listen)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		return errors.New("CAUDAL_LISTEN must be a loopback IP and port")
	}
	password, err := credential("CAUDAL_OWNER_PASSWORD")
	if err != nil {
		return err
	}
	mcpToken, err := credential("CAUDAL_MCP_TOKEN")
	if err != nil {
		return err
	}
	deepSeek, err := credential("DEEPSEEK_API_KEY")
	if err != nil {
		return err
	}
	if deepSeek == "" && os.Getenv("CAUDAL_DOTENV") != "" {
		deepSeek, err = dotenvKey(os.Getenv("CAUDAL_DOTENV"))
		if err != nil {
			return err
		}
	}
	profiles, err := teleport.New(os.Getenv("CAUDAL_TELEPORT_PROFILES"))
	if err != nil {
		return fmt.Errorf("CAUDAL_TELEPORT_PROFILES: %w", err)
	}
	runner, err := operations.New(os.Getenv("CAUDAL_OPERATIONS"))
	if err != nil {
		return fmt.Errorf("CAUDAL_OPERATIONS: %w", err)
	}
	store, err := fleet.Open(environment("CAUDAL_DATA_DIR", ".caudal/fleet"), nil)
	if err != nil {
		return err
	}
	defer store.Close()

	handler, err := control.New(control.Config{
		Origin:             environment("CAUDAL_ORIGIN", "http://"+listen),
		OwnerPassword:      password,
		MCPToken:           mcpToken,
		DeepSeek:           control.DeepSeek{Key: deepSeek},
		Teleport:           profiles,
		Operations:         runner,
		ControlPlaneNodeID: os.Getenv("CAUDAL_CONTROL_PLANE_NODE_ID"),
		WebDir:             environment("CAUDAL_WEB_DIR", "web/dist"),
		DownloadDir:        os.Getenv("CAUDAL_DOWNLOAD_DIR"),
		BuildVersion:       version,
	}, store)
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr: listen, Handler: handler, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second,
		IdleTimeout: 45 * time.Second, MaxHeaderBytes: 16 << 10,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}

	listener, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	slog.Info("Caudal listening", "address", listener.Addr().String(), "version", version)
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	select {
	case err = <-serveErr:
		return err
	case <-ctx.Done():
		timeout, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		err := server.Shutdown(timeout)
		if err != nil {
			_ = server.Close()
		}
		return err
	}
}

func environment(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func credential(name string) (string, error) {
	if file := os.Getenv(name + "_FILE"); file != "" {
		info, err := os.Stat(file)
		if err != nil {
			return "", fmt.Errorf("read %s_FILE: %w", name, err)
		}
		disallowed := os.FileMode(0077)
		if directory := os.Getenv("CREDENTIALS_DIRECTORY"); directory != "" &&
			(file == filepath.Join(directory, "owner-password") || file == filepath.Join(directory, "mcp-token")) {
			// systemd may grant the service a private per-user ACL with mode 0440.
			disallowed = 0037
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&disallowed != 0 || info.Size() > 4096 {
			return "", fmt.Errorf("%s_FILE must be a private regular file", name)
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return "", fmt.Errorf("read %s_FILE: %w", name, err)
		}
		return strings.TrimSpace(string(data)), nil
	}
	return strings.TrimSpace(os.Getenv(name)), nil
}

// Only the DeepSeek key is read from the explicitly selected local development file.
func dotenvKey(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		name, value, found := strings.Cut(strings.TrimSpace(scanner.Text()), "=")
		if found && name == "DEEPSEEK_API_KEY" {
			return strings.Trim(strings.TrimSpace(value), "\"'"), nil
		}
	}
	return "", scanner.Err()
}
