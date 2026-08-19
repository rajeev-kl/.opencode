#!/usr/bin/env python3
"""pitlane-mcp stdio wrapper — transparent MCP relay with Discovery interception.

Why this exists:
  agy (Antigravity CLI >= 1.1.14) sends the MCP Discovery extension request
  `server/discover` BEFORE `initialize` when it connects to a stdio server.
  pitlane-mcp's server layer (rmcp) requires `initialize` as the very first
  request and responds to `server/discover` by closing the connection with
  "expect initialized request", which makes agy report the server as failed.

  Per the MCP Discovery extension spec, a server that does not support
  discovery should answer with a JSON-RPC error so the client falls back to
  the standard initialize flow. This wrapper answers `server/discover` with
  -32601 Method not found and relays every other message transparently to the
  real binary (installed alongside as `pitlane-mcp-bin`).

  Clients that never send `server/discover` (opencode, claude, codex) are
  unaffected — for them this is a pass-through relay.

Installed by .opencode/mcp/setup.sh into ~/.local/bin/pitlane-mcp.
"""
import json
import subprocess
import sys
import threading

SERVER = "pitlane-mcp-bin"
DISCOVERY_ERROR = {
    "code": -32601,
    "message": (
        "Method not found: server/discover is not supported "
        "(pitlane-mcp requires initialize as the first request)"
    ),
}


def main() -> int:
    server = subprocess.Popen(
        [SERVER],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=sys.stderr,  # pass server logs through to the client's stderr
        text=True,
        bufsize=1,
    )

    def relay():
        """Echo server stdout to our stdout until the server exits."""
        try:
            for line in server.stdout:
                sys.stdout.write(line)
                sys.stdout.flush()
        except (BrokenPipeError, OSError):
            pass

    threading.Thread(target=relay, daemon=True).start()

    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("method") == "server/discover":
                resp = {
                    "jsonrpc": "2.0",
                    "id": msg.get("id"),
                    "error": dict(DISCOVERY_ERROR),
                }
                sys.stdout.write(json.dumps(resp) + "\n")
                sys.stdout.flush()
                continue
            try:
                server.stdin.write(line)
                server.stdin.flush()
            except (BrokenPipeError, OSError):
                break
    except KeyboardInterrupt:
        pass

    try:
        server.stdin.close()
    except OSError:
        pass
    return server.wait()


if __name__ == "__main__":
    sys.exit(main())
