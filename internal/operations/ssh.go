package operations

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	uptimePath  = "/usr/bin/uptime"
	outputLimit = 4096
)

var uptimePattern = regexp.MustCompile(`^[ \t]*[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?[ \t]+up[ \t]+((?:[0-9]{1,7} days?,[ \t]+)?(?:[0-9]{1,3}:[0-9]{2}|[0-9]{1,3}[ \t]+min)|[0-9]{1,7} days?)[ \t]*,[ \t]+[0-9]{1,7}[ \t]+users?,[ \t]+load averages?:[ \t]+([0-9]{1,7}\.[0-9]{1,4}),[ \t]+([0-9]{1,7}\.[0-9]{1,4}),[ \t]+([0-9]{1,7}\.[0-9]{1,4})[ \t]*\r?$`)

func (r *Registry) executeSSH(ctx context.Context, op operation) (string, []string) {
	c := op.config
	if !safeFile(c.IdentityFile, true) {
		return Failed, []string{"Dedicated diagnostic credential unavailable."}
	}
	binary := "/usr/bin/ssh"
	args := sshArgs(c)
	env := []string{"PATH=/usr/bin:/bin", "HOME=/nonexistent", "LANG=C", "LC_ALL=C"}
	if c.Transport == "ssh" {
		if !knownHostPinned(c.KnownHostsFile, c.Target) {
			return Failed, []string{"Expected SSH host pin unavailable."}
		}
	} else {
		binary = r.findTSH()
		if binary == "" {
			return Failed, []string{"Dedicated tsh client unavailable."}
		}
		home, err := os.MkdirTemp("", "caudal-tsh-")
		if err != nil {
			return Failed, []string{"Could not initialize isolated tsh configuration."}
		}
		defer os.RemoveAll(home)
		globalConfig := filepath.Join(home, "global.yaml")
		if err := os.WriteFile(globalConfig, []byte("{}\n"), 0600); err != nil {
			return Failed, []string{"Could not initialize isolated tsh configuration."}
		}
		env = append(env, "TELEPORT_HOME="+home, "TELEPORT_GLOBAL_TSH_CONFIG="+globalConfig, "TELEPORT_TOOLS_VERSION=off")
		args = tshArgs(c)
	}
	data, err := r.runCommand(ctx, binary, args, env)
	if err != nil {
		return Failed, []string{"The SSH diagnostic could not complete."}
	}
	match := uptimePattern.FindStringSubmatch(strings.TrimSuffix(string(data), "\n"))
	if len(match) == 0 || len(data) > outputLimit {
		return Failed, []string{"The host returned an unexpected uptime response."}
	}
	return OK, []string{
		"Uptime: " + strings.Join(strings.Fields(match[1]), " "),
		"Load average (1m / 5m / 15m): " + strings.Join(match[2:], " / "),
	}
}

func sshArgs(c config) []string {
	return []string{
		"-F", "/dev/null", "-T", "-n", "-e", "none", "-S", "none", "-p", strconv.Itoa(c.Port), "-l", c.Login,
		"-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ConnectionAttempts=1",
		"-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "-o", "CheckHostIP=no",
		"-o", "UserKnownHostsFile=" + c.KnownHostsFile, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "HostKeyAlias=" + c.Target,
		"-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-i", c.IdentityFile,
		"-o", "PreferredAuthentications=publickey", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
		"-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
		"-o", "ControlMaster=no", "-o", "ProxyJump=none", "-o", "ProxyCommand=none",
		"--", c.Host, uptimePath,
	}
}

func tshArgs(c config) []string {
	return []string{
		"--identity=" + c.IdentityFile, "--proxy=" + c.Proxy, "--relay=none", "--add-keys-to-agent=no", "--mfa-mode=otp", "--no-os-log", "ssh",
		"--cluster=" + c.Cluster, "--no-relogin", "--request-mode=off", "--no-tty", "--no-forward-agent", "--no-local",
		"--no-x11-untrusted", "--no-x11-trusted", "--no-enable-escape-sequences", "--no-fork-after-authentication",
		"--", c.Login + "@" + c.Target, uptimePath,
	}
}

func tshBinary() string {
	for _, path := range []string{"/usr/bin/tsh", "/usr/local/bin/tsh", "/opt/homebrew/bin/tsh"} {
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
			return path
		}
	}
	return ""
}

func safeFile(path string, secret bool) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 64<<10 {
		return false
	}
	forbidden := os.FileMode(0022)
	if secret {
		forbidden = 0077
		// systemd may use a service-specific ACL represented as a group-read mode bit.
		if dir := os.Getenv("CREDENTIALS_DIRECTORY"); dir != "" && filepath.Dir(path) == dir {
			forbidden = 0037
		}
	}
	return info.Mode().Perm()&forbidden == 0
}

func knownHostPinned(path, alias string) bool {
	if !safeFile(path, false) {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	lines := bufio.NewScanner(io.LimitReader(file, 64<<10))
	pin := false
	for lines.Scan() {
		line := strings.TrimSpace(lines.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 3 || fields[0] != alias {
			return false
		}
		pin = true
	}
	return pin && lines.Err() == nil
}

type boundedOutput struct{ buffer bytes.Buffer }

func (b *boundedOutput) Write(data []byte) (int, error) {
	space := outputLimit - b.buffer.Len()
	if len(data) > space {
		n, _ := b.buffer.Write(data[:space])
		return n, errors.New("diagnostic output exceeded the size limit")
	}
	return b.buffer.Write(data)
}

func runDiagnostic(ctx context.Context, binary string, args, env []string) ([]byte, error) {
	out := &boundedOutput{}
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Env = env
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.WaitDelay = 500 * time.Millisecond
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return out.buffer.Bytes(), nil
}
