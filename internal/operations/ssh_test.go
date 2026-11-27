package operations

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

const uptimeFixture = " 17:03:14 up 5 days,  1:01,  2 users,  load average: 0.19, 0.03, 0.01\n"

func TestSSHFixedDiagnosticRequiresCredentialAndExactPin(t *testing.T) {
	dir := t.TempDir()
	id := filepath.Join(dir, "identity")
	pin := filepath.Join(dir, "known-hosts")
	registry := configured(t, config{ID: "probe", Label: "Diagnostic", Transport: "ssh", Target: "pilot",
		Host: "127.0.0.1", Port: 2222, Login: "observer", IdentityFile: id, KnownHostsFile: pin})
	var count int
	registry.runCommand = func(_ context.Context, binary string, args, env []string) ([]byte, error) {
		count++
		if binary != "/usr/bin/ssh" || !slices.Equal(args[len(args)-3:], []string{"--", "127.0.0.1", uptimePath}) ||
			!slices.Equal(env, []string{"PATH=/usr/bin:/bin", "HOME=/nonexistent", "LANG=C", "LC_ALL=C"}) {
			t.Error("native invocation used unexpected binary, arguments or environment")
		}
		for _, arg := range []string{"HostKeyAlias=pilot", "UserKnownHostsFile=" + pin, "GlobalKnownHostsFile=/dev/null", "StrictHostKeyChecking=yes", "UpdateHostKeys=no",
			"IdentityAgent=none", "IdentitiesOnly=yes", "BatchMode=yes", "ClearAllForwardings=yes", "ForwardAgent=no", "ForwardX11=no", "ProxyCommand=none", "-T", "-n", "2222", "observer", id} {
			if !slices.Contains(args, arg) {
				t.Errorf("native diagnostic missing fixed parameter %q", arg)
			}
		}
		return []byte(uptimeFixture), nil
	}
	if r := registry.Execute(t.Context(), "probe"); r.Status != Failed || count != 0 {
		t.Fatal("missing dedicated key must block dispatch")
	}
	write := func(path, data string, mode os.FileMode) {
		t.Helper()
		if err := os.WriteFile(path, []byte(data), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
	}
	write(id, "synthetic key material", 0600)
	write(pin, "* ssh-ed25519 synthetic\npilot ssh-ed25519 synthetic\n", 0600)
	if r := registry.Execute(t.Context(), "probe"); r.Status != Failed || count != 0 {
		t.Fatal("wildcard pin must block dispatch")
	}
	write(pin, "# dedicated exact alias\n\npilot ssh-ed25519 synthetic\n", 0400)
	write(id, "synthetic key material", 0644)
	if r := registry.Execute(t.Context(), "probe"); r.Status != Failed || count != 0 {
		t.Fatal("readable key must block dispatch")
	}
	write(id, "synthetic key material", 0440)
	t.Setenv("CREDENTIALS_DIRECTORY", dir)
	result := registry.Execute(t.Context(), "probe")
	if result.Status != OK || count != 1 || !slices.Equal(result.Lines, []string{
		"Uptime: 5 days, 1:01", "Load average (1m / 5m / 15m): 0.19 / 0.03 / 0.01",
	}) {
		t.Fatalf("unexpected typed diagnostic result: %+v", result)
	}
	registry.runCommand = func(context.Context, string, []string, []string) ([]byte, error) {
		return nil, errors.New("synthetic confidential diagnostic")
	}
	if r := registry.Execute(t.Context(), "probe"); r.Status != Failed || strings.Contains(strings.Join(r.Lines, ""), "synthetic") {
		t.Fatalf("raw diagnostic error exposure: %+v", r)
	}
	registry.runCommand = func(context.Context, string, []string, []string) ([]byte, error) {
		return []byte("\x1b[31m" + uptimeFixture + "synthetic sensitive result"), nil
	}
	if r := registry.Execute(t.Context(), "probe"); r.Status != Failed || strings.Contains(strings.Join(r.Lines, ""), "synthetic") {
		t.Fatalf("raw diagnostic stdout exposure: %+v", r)
	}
}

func TestTeleportUsesAnIsolatedNonInteractiveMachineIdentity(t *testing.T) {
	identity := filepath.Join(t.TempDir(), "machine-identity")
	if err := os.WriteFile(identity, []byte("synthetic identity"), 0400); err != nil {
		t.Fatal(err)
	}
	registry := configured(t, config{ID: "lab", Label: "Lab via Teleport", Transport: "tsh", Target: nodeUUID,
		Login: "observer", IdentityFile: identity, Proxy: "teleport.example.com:443", Cluster: "lab"})
	registry.findTSH = func() string { return "" }
	if r := registry.Execute(t.Context(), "lab"); r.Status != Failed {
		t.Fatal("missing Teleport client must block dispatch")
	}
	registry.findTSH = func() string { return "/usr/bin/tsh" }
	var home string
	registry.runCommand = func(_ context.Context, binary string, args, env []string) ([]byte, error) {
		if binary != "/usr/bin/tsh" || !slices.Equal(args[len(args)-3:], []string{"--", "observer@" + nodeUUID, uptimePath}) {
			t.Fatal("Teleport operation did not target the exact configured node")
		}
		for _, arg := range []string{"--identity=" + identity, "--proxy=teleport.example.com:443", "--cluster=lab", "--no-relogin", "--request-mode=off",
			"--relay=none", "--no-tty", "--no-forward-agent", "--no-local", "--no-x11-trusted", "--no-x11-untrusted", "--mfa-mode=otp", "--no-os-log"} {
			if !slices.Contains(args, arg) {
				t.Errorf("Teleport diagnostic missing fixed parameter %q", arg)
			}
		}
		for _, item := range env {
			if value, ok := strings.CutPrefix(item, "TELEPORT_HOME="); ok {
				home = value
			}
			if strings.HasPrefix(item, "SSH_AUTH_SOCK=") || strings.HasPrefix(item, "HTTPS_PROXY=") {
				t.Error("ambient credentials or routing leaked into tsh")
			}
		}
		if home == "" || !slices.Contains(env, "TELEPORT_TOOLS_VERSION=off") ||
			!slices.Contains(env, "TELEPORT_GLOBAL_TSH_CONFIG="+filepath.Join(home, "global.yaml")) {
			t.Fatal("Teleport profile was not isolated")
		}
		return []byte(uptimeFixture), nil
	}
	if r := registry.Execute(t.Context(), "lab"); r.Status != OK {
		t.Fatalf("unexpected result: %+v", r)
	}
	if _, err := os.Stat(home); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("ephemeral profile directory remained after execution")
	}
}

func TestDiagnosticProcessFixture(t *testing.T) {
	mode := os.Getenv("CAUDAL_DIAGNOSTIC_FIXTURE")
	if mode == "" {
		return
	}
	_, _ = fmt.Fprint(os.Stderr, "synthetic stderr")
	switch mode {
	case "good":
		_, _ = fmt.Fprint(os.Stdout, uptimeFixture)
	case "large":
		_, _ = fmt.Fprint(os.Stdout, strings.Repeat("x", outputLimit+1))
	case "slow":
		time.Sleep(10 * time.Second)
	}
	os.Exit(0)
}

func TestDiagnosticExecBoundsProcessAndDiscardsStderr(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	args := []string{"-test.run=^TestDiagnosticProcessFixture$"}
	env := []string{"GORACE=atexit_sleep_ms=0", "CAUDAL_DIAGNOSTIC_FIXTURE=good"}
	if result, err := runDiagnostic(t.Context(), self, args, env); err != nil || string(result) != uptimeFixture {
		t.Fatalf("expected bounded stdout without stderr, got %q, %v", result, err)
	}
	env[1] = "CAUDAL_DIAGNOSTIC_FIXTURE=large"
	if result, err := runDiagnostic(t.Context(), self, args, env); err == nil || result != nil {
		t.Fatal("oversize capture produced an output")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 25*time.Millisecond)
	defer cancel()
	env[1] = "CAUDAL_DIAGNOSTIC_FIXTURE=slow"
	if result, err := runDiagnostic(ctx, self, args, env); err == nil || result != nil {
		t.Fatal("timed-out command produced an output")
	}
}
