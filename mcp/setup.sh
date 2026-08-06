#!/usr/bin/env bash
# setup.sh — pitlane-mcp graph setup for this opencode config.
#
# Self-contained: everything lives inside `.opencode/mcp/` (binaries, server
# definition, docs). The graph index itself is runtime data under
# `~/.pitlane/indexes/` (keyed by project path hash) — pitlane-mcp has no
# config override for that location.
#
# Usage:
#   .opencode/mcp/setup.sh                # install binary + index current dir
#   .opencode/mcp/setup.sh <project-dir>  # index a specific project dir
#   .opencode/mcp/setup.sh --verify       # check all three integrations
#   .opencode/mcp/setup.sh --uninstall    # remove binary + index cache
#
# Idempotent: safe to re-run. The binary download is skipped when the pinned
# version is already present.

set -euo pipefail

PITLANE_VERSION="v0.11.1"
MCP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$MCP_DIR/bin"
BIN="$BIN_DIR/pitlane-mcp"
CLI="$BIN_DIR/pitlane"

# Project root = parent of `.opencode/` (this config lives in <proj>/.opencode/,
# and the script itself lives in <proj>/.opencode/mcp/, so go up two levels).
PROJECT_ROOT="$(cd "$MCP_DIR/../.." && pwd)"
PROJECT="${1:-$PROJECT_ROOT}"
if [[ "${1:-}" == "--verify" || "${1:-}" == "--uninstall" ]]; then
  PROJECT="$PROJECT_ROOT"
fi

log()  { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[1;33m!\033[0m %s\n" "$*"; }
die()  { printf "  \033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    linux)  os="linux" ;;
    darwin) os="macos" ;;
    msys*|cygwin*|mingw*) os="windows" ;;
    *) die "Unsupported OS: $os" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *) die "Unsupported arch: $arch" ;;
  esac
  if [[ "$os" == "windows" ]]; then
    echo "windows-x86_64.zip"
  else
    echo "pitlane-mcp-$os-$arch.tar.gz"
  fi
}

install_binary() {
  [[ -x "$BIN" ]] && return 0
  mkdir -p "$BIN_DIR"
  local asset url tmp
  asset="$(detect_platform)"
  url="https://github.com/eresende/pitlane-mcp/releases/download/$PITLANE_VERSION/$asset"
  echo "  Downloading pitlane-mcp $PITLANE_VERSION ($asset)..."
  tmp="$(mktemp -d)"
  if [[ "$asset" == *.zip ]]; then
    curl -fsSL "$url" -o "$tmp/pitlane.zip"
    (cd "$tmp" && unzip -o pitlane.zip >/dev/null)
  else
    curl -fsSL "$url" -o "$tmp/pitlane.tar.gz"
    (cd "$tmp" && tar xzf pitlane.tar.gz)
  fi
  install -m 0755 "$tmp/pitlane-mcp" "$BIN"
  install -m 0755 "$tmp/pitlane" "$CLI"
  rm -rf "$tmp"
  log "installed pitlane-mcp to $BIN"
}

build_index() {
  if [[ ! -x "$CLI" ]]; then
    warn "pitlane CLI not found; skipping index build (run without --verify first)"
    return 0
  fi
  echo "  Indexing $PROJECT ..."
  # `not-used/` is abandoned (AGENTS.md: never read/reference) and `extra/` is
  # read-only partner material — keep both out of the graph.
  (cd "$PROJECT" && "$CLI" index . --exclude "not-used/**" --exclude "extra/**" >/dev/null 2>&1)
  log "index built for $PROJECT (not-used/ and extra/ excluded)"
}

verify_integrations() {
  echo "  Verifying integrations..."
  local ok=0

  if command -v opencode >/dev/null 2>&1; then
    if opencode mcp list 2>&1 | grep -q "pitlane.*connected"; then
      log "opencode: pitlane MCP connected"
      ok=$((ok+1))
    else
      warn "opencode: pitlane MCP not connected — check .opencode/opencode.json"
    fi
  else
    warn "opencode not found in PATH"
  fi

  if command -v claude >/dev/null 2>&1; then
    if echo "List the MCP tools from the pitlane server." | claude --print \
        --mcp-config "$MCP_DIR/pitlane.json" 2>/dev/null | grep -q "pitlane"; then
      log "claude: --mcp-config exposes pitlane tools"
      ok=$((ok+1))
    else
      warn "claude: --mcp-config did not expose pitlane tools"
    fi
  else
    warn "claude not found in PATH"
  fi

  if command -v codex >/dev/null 2>&1; then
    warn "codex: configured via plugin -c override (no global config); verify in a session"
    ok=$((ok+1))
  else
    warn "codex not found in PATH"
  fi

  echo ""
  echo "  $ok/3 integrations ready."
}

uninstall() {
  rm -rf "$BIN_DIR"
  rm -rf "$HOME/.pitlane/indexes" 2>/dev/null || true
  echo "  Removed pitlane-mcp binary, CLI, and local index cache."
}

# ── main ────────────────────────────────────────────────────────────────────
case "${1:-}" in
  --verify)   verify_integrations ;;
  --uninstall) uninstall ;;
  *)
    install_binary
    build_index
    echo ""
    echo "  Done. pitlane-mcp is available to:"
    echo "    - opencode  (Manager + subagents, via .opencode/opencode.json)"
    echo "    - claude    (--mcp-config .opencode/mcp/pitlane.json)"
    echo "    - codex     (-c mcp_servers.pitlane.command=... in the plugin)"
    echo ""
    echo "  Next: .opencode/mcp/setup.sh --verify"
    ;;
esac
