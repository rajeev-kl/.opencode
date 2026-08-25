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

Environment injection:
  setup.sh syncs .opencode/mcp/pitlane.env -> ~/.pitlane/env. Before spawning
  the real binary, this wrapper loads that file (if present) into the child
  environment: KEY=VALUE lines, #' comments, surrounding quotes stripped,
  $VARS/${VARS} expanded, ~ expanded. Additionally, when
  PITLANE_EMBED_API_KEY_FILE is set and PITLANE_EMBED_API_KEY is not, the key
  is read from that file — so secrets stay out of the repo while every client
  (opencode, claude, codex, agy relay) gets identical semantic-search config.
"""
import json
import os
import subprocess
import sys
import threading

SERVER = "pitlane-mcp-bin"
ENV_FILE = os.path.expanduser("~/.pitlane/env")
DISCOVERY_ERROR = {
    "code": -32601,
    "message": (
        "Method not found: server/discover is not supported "
        "(pitlane-mcp requires initialize as the first request)"
    ),
}


def _clean_value(value: str) -> str:
    """Strip one layer of matching surrounding quotes, then expand vars/~."""
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        value = value[1:-1]
    return os.path.expanduser(os.path.expandvars(value))


def load_env_file(path: str) -> None:
    """Load KEY=VALUE lines from `path` into os.environ (existing wins)."""
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), _clean_value(value.strip())
        if not key or not value or key in os.environ:
            continue
        os.environ[key] = value


def resolve_api_key_from_file() -> None:
    """PITLANE_EMBED_API_KEY_FILE -> PITLANE_EMBED_API_KEY (file wins format)."""
    key_file = os.environ.get("PITLANE_EMBED_API_KEY_FILE", "")
    if not key_file or os.environ.get("PITLANE_EMBED_API_KEY"):
        return
    try:
        with open(os.path.expanduser(key_file), encoding="utf-8") as fh:
            key = fh.read().strip()
    except OSError:
        print(
            f"pitlane-mcp wrapper: PITLANE_EMBED_API_KEY_FILE not readable: {key_file}",
            file=sys.stderr,
        )
        return
    if key:
        os.environ["PITLANE_EMBED_API_KEY"] = key


def main() -> int:
    load_env_file(ENV_FILE)
    resolve_api_key_from_file()
    server = subprocess.Popen(
        [SERVER],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=sys.stderr,  # pass server logs through to the client's stderr
        text=True,
        bufsize=1,
        env=os.environ,
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
