"""Exercise the released binaries on an isolated Linux host without real credentials."""

import http.cookiejar
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import ExitStack, contextmanager
from pathlib import Path


@contextmanager
def process(executable, env):
    with subprocess.Popen([executable], env=env, stdout=subprocess.DEVNULL) as child:
        try:
            yield child
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()


def until(action):
    for _ in range(50):
        try:
            result = action()
        except (ConnectionError, urllib.error.URLError):
            result = None
        if result:
            return result
        time.sleep(0.2)
    raise RuntimeError("release smoke timed out")


def run(release):
    cookie_jar = http.cookiejar.CookieJar()
    browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))

    with socket.socket() as port, ExitStack() as cleanup:
        port.bind(("127.0.0.1", 0))
        listen = f"127.0.0.1:{port.getsockname()[1]}"
        origin = f"http://{listen}"
        port.close()
        state = Path(cleanup.enter_context(tempfile.TemporaryDirectory()))
        owner = state / "owner"
        mcp = state / "mcp"
        for file in (owner, mcp):
            file.touch(mode=0o600)
            file.write_text(secrets.token_urlsafe(48))
        env = {
            "PATH": os.environ["PATH"],
            "CAUDAL_OWNER_PASSWORD_FILE": str(owner),
            "CAUDAL_MCP_TOKEN_FILE": str(mcp),
            "CAUDAL_LISTEN": listen,
            "CAUDAL_ORIGIN": origin,
            "CAUDAL_DATA_DIR": str(state / "fleet"),
            "CAUDAL_WEB_DIR": str(release / "web"),
            "CAUDAL_DOWNLOAD_DIR": str(release / "downloads"),
        }
        cleanup.enter_context(process(release / "caudal", env))

        def request(path, data=None, headers=None, opener=browser):
            req = urllib.request.Request(origin + path, headers=headers or {})
            if data is not None:
                req.data = json.dumps(data).encode()
                req.add_header("Content-Type", "application/json")
            with opener.open(req, timeout=3) as response:
                return response.read()

        health = json.loads(until(lambda: request("/healthz")))
        assert health["version"] == (release / "REVISION").read_text().strip()
        assert b"<html" in request("/")
        try:
            request("/api/v1/fleet")
        except urllib.error.HTTPError as error:
            assert error.code == 401
        else:
            raise RuntimeError("fleet was visible without a session")

        assert json.loads(request("/api/v1/session", {"password": owner.read_text()}))["authenticated"]
        result = json.loads(request("/api/v1/nodes", {"name": "Linux smoke fixture", "region": "CI"}))
        assert result["node"]["status"] == "pending"
        token = state / "agent"
        token.touch(mode=0o600)
        token.write_text(result["token"])
        agent = release / "downloads" / "caudal-agent-linux-amd64"
        cleanup.enter_context(process(agent, {
            "PATH": os.environ["PATH"], "CAUDAL_URL": origin, "CAUDAL_TOKEN_FILE": str(token),
        }))

        def healthy_node():
            node = json.loads(request("/api/v1/fleet"))["nodes"][0]
            return node if node["status"] == "healthy" else None

        node = until(healthy_node)
        assert node["metrics"]["memory_total_bytes"] > 0
        history = json.loads(request(f"/api/v1/nodes/{node['id']}/samples"))
        assert history["samples"][0]["observed_at"] == node["last_seen"]

        headers = {
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {mcp.read_text()}",
        }
        payload = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "clientInfo": {"name": "release-smoke", "version": "1"},
        }}
        assert json.loads(request("/mcp", payload, headers))["result"]["protocolVersion"] == "2025-11-25"
        headers["MCP-Protocol-Version"] = "2025-11-25"
        payload = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "caudal_list_fleet", "arguments": {},
        }}
        result = json.loads(request("/mcp", payload, headers))["result"]
        assert result["structuredContent"]["nodes"][0]["id"] == node["id"]
        print("Release smoke passed: login, Linux heartbeat, history, MCP")


if __name__ == "__main__":
    run(Path(sys.argv[1]).resolve())
