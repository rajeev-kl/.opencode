#!/usr/bin/env bash
# setup.sh — pitlane-mcp graph setup for this opencode config.
#
# Installs the shared pitlane binaries + the discovery wrapper once per machine
# into ~/.local/bin (no per-project copies, resolved via PATH by every client),
# then builds the tree-sitter graph index for the project.
#
# Layout on disk after setup:
#   ~/.local/bin/pitlane          pitlane CLI        (index/search/stats)
#   ~/.local/bin/pitlane-mcp-bin  real pitlane-mcp server (spawned by the wrapper)
#   ~/.local/bin/pitlane-mcp      python wrapper (this repo's pitlane-mcp-wrapper.py)
#
# The wrapper spawns `pitlane-mcp-bin` and answers `server/discover` itself so
# agy (Antigravity CLI >= 1.1.14) can connect; opencode/claude/codex use it as
# a transparent relay. See pitlane-mcp-wrapper.py in this directory.
#
# The graph index itself is runtime data under `~/.pitlane/indexes/` (keyed by
# project path hash) — pitlane-mcp has no config override for that location.
#
# Usage:
#   .opencode/mcp/setup.sh                # install binaries + index current project
#   .opencode/mcp/setup.sh <project-dir>  # index a specific project dir
#   .opencode/mcp/setup.sh --verify       # check binaries + integrations
#   .opencode/mcp/setup.sh --uninstall    # remove binaries + index cache
#
# Idempotent: safe to re-run. The binary download is skipped when the pinned
# version is already present. Env overrides:
#   PITLANE_VERSION    version tag to download (default v0.12.2)
#   PITLANE_EXCLUDES   space-separated globs to exclude from the index
#                      (default: not-used/** extra/** .venv/** node_modules/**)
#   PITLANE_INDEX_FORCE=1  rebuild the index with --force
#
# Semantic search: `pitlane.env` in this directory holds the embedding-server
# config (Unsloth Studio on 127.0.0.1:1235 — see ~/Projects/unsloth/embedding.sh).
# setup.sh syncs it to ~/.pitlane/env, where the pitlane-mcp wrapper picks it
# up for every client; build_index sources it so CLI indexing embeds too. The
# API key itself is resolved at runtime from PITLANE_EMBED_API_KEY_FILE
# (default ~/.unsloth/harness.key) and never stored in this repo.

set -euo pipefail

PITLANE_VERSION="${PITLANE_VERSION:-v0.12.2}"
MCP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_BIN="$HOME/.local/bin"
CLI="$LOCAL_BIN/pitlane"
SERVER_BIN="$LOCAL_BIN/pitlane-mcp-bin"
WRAPPER="$LOCAL_BIN/pitlane-mcp"
WRAPPER_SRC="$MCP_DIR/pitlane-mcp-wrapper.py"
INDEX_CACHE="$HOME/.pitlane/indexes"
ENV_SRC="$MCP_DIR/pitlane.env"
ENV_INSTALLED="$HOME/.pitlane/env"

# Project root = parent of `.opencode/` (this config lives in <proj>/.opencode/,
# and the script itself lives in <proj>/.opencode/mcp/, so go up two levels).
PROJECT_ROOT="$(cd "$MCP_DIR/../.." && pwd)"
PROJECT="${1:-$PROJECT_ROOT}"
case "${1:-}" in
  --verify|--uninstall) PROJECT="$PROJECT_ROOT" ;;
esac

if [[ -n "${PITLANE_EXCLUDES:-}" ]]; then
  # shellcheck disable=SC2206 # deliberate word-split of the env override
  IFS=' ' read -r -a EXCLUDES <<< "$PITLANE_EXCLUDES"
else
  EXCLUDES=("not-used/**" "extra/**" ".venv/**" "node_modules/**")
fi

# Source the installed pitlane.env (fallback: repo copy) and resolve the API
# key from PITLANE_EMBED_API_KEY_FILE. Used at index time and by --verify.
load_pitlane_env() {
  local env_file="$ENV_INSTALLED"
  [[ -f "$env_file" ]] || env_file="$ENV_SRC"
  [[ -f "$env_file" ]] || return 0
  # shellcheck disable=SC1090
  set -a; source "$env_file"; set +a
  if [[ -n "${PITLANE_EMBED_API_KEY_FILE:-}" && -z "${PITLANE_EMBED_API_KEY:-}" ]]; then
    local kf
    kf="$(eval "printf '%s' \"$PITLANE_EMBED_API_KEY_FILE\"")"
    if [[ -f "$kf" ]]; then
      export PITLANE_EMBED_API_KEY="$(tr -d '[:space:]' < "$kf")"
    fi
  fi
}

# Sync the repo config to the machine-local location the wrapper reads.
sync_env_file() {
  if [[ ! -f "$ENV_SRC" ]]; then
    return 0
  fi
  if [[ -f "$ENV_INSTALLED" ]] && cmp -s "$ENV_SRC" "$ENV_INSTALLED"; then
    log "pitlane.env already synced ($ENV_INSTALLED)"
    return 0
  fi
  mkdir -p "$(dirname "$ENV_INSTALLED")"
  install -m 0644 "$ENV_SRC" "$ENV_INSTALLED"
  log "synced pitlane.env -> $ENV_INSTALLED (semantic search config)"
}

log()  { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[1;33m!\033[0m %s\n" "$*"; }
die()  { printf "  \033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

is_elf() { [[ -f "$1" ]] && [[ "$(head -c 4 "$1" 2>/dev/null)" == $'\x7fELF' ]]; }

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

# Make sure ~/.local/bin is on PATH (the wrapper spawns `pitlane-mcp-bin` bare;
# opencode/claude/codex resolve `pitlane-mcp` bare — both must be found).
ensure_local_bin_on_path() {
  case ":$PATH:" in
    *":$LOCAL_BIN:"*) return 0 ;;
  esac
  warn "$LOCAL_BIN is not on PATH — MCP clients will not find pitlane-mcp"
  warn "  add 'export PATH=\"\$HOME/.local/bin:\$PATH\"' to your shell rc"
}

install_binaries() {
  # Outcome: $CLI and $SERVER_BIN both present + executable.
  if [[ -x "$CLI" && -x "$SERVER_BIN" ]]; then
    log "binaries already installed ($CLI, $SERVER_BIN)"
    return 0
  fi

  # Migration: on machines set up before the wrapper existed, `pitlane-mcp` is
  # the REAL server binary. Move it to `pitlane-mcp-bin` so the wrapper can
  # take the user-facing name (this is the pitlane-mcp-bin fix).
  if is_elf "$WRAPPER" && [[ ! -x "$SERVER_BIN" ]]; then
    mv -f "$WRAPPER" "$SERVER_BIN"
    log "migrated existing server binary $WRAPPER -> $SERVER_BIN"
  fi
  if [[ -x "$CLI" && -x "$SERVER_BIN" ]]; then
    log "binaries ready after migration"
    return 0
  fi

  # Download once, machine-wide, into ~/.local/bin.
  mkdir -p "$LOCAL_BIN"
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
  install -m 0755 "$tmp/pitlane" "$CLI"
  if [[ "$asset" == windows-* ]]; then
    # Windows: the bash/python wrapper doesn't apply — the real server keeps
    # the `pitlane-mcp` name and agy compatibility is skipped.
    install -m 0755 "$tmp/pitlane-mcp" "$WRAPPER"
    log "installed pitlane-mcp server to $WRAPPER (windows: no wrapper)"
  else
    install -m 0755 "$tmp/pitlane-mcp" "$SERVER_BIN"
    log "installed pitlane-mcp server to $SERVER_BIN"
    log "installed pitlane CLI to $CLI"
  fi
  rm -rf "$tmp"
}

install_wrapper() {
  if [[ ! -f "$WRAPPER_SRC" ]]; then
    warn "wrapper source missing: $WRAPPER_SRC (not installing)"
    return 0
  fi
  if is_elf "$WRAPPER"; then
    if [[ -x "$SERVER_BIN" ]]; then
      rm -f "$WRAPPER"  # redundant real server under the wrapper name
    else
      mv -f "$WRAPPER" "$SERVER_BIN"
      log "migrated existing server binary $WRAPPER -> $SERVER_BIN"
    fi
  fi
  if [[ -f "$WRAPPER" ]] && cmp -s "$WRAPPER_SRC" "$WRAPPER"; then
    log "wrapper already installed ($WRAPPER)"
    return 0
  fi
  install -m 0755 "$WRAPPER_SRC" "$WRAPPER"
  log "installed pitlane-mcp wrapper -> $WRAPPER"
}

build_index() {
  if [[ ! -x "$CLI" ]]; then
    warn "pitlane CLI not found; skipping index build (run without --verify first)"
    return 0
  fi
  load_pitlane_env
  local index_args=()
  local e
  for e in "${EXCLUDES[@]}"; do index_args+=(--exclude "$e"); done
  [[ "${PITLANE_INDEX_FORCE:-}" == "1" ]] && index_args+=(--force)
  echo "  Indexing $PROJECT ..."
  (cd "$PROJECT" && "$CLI" index . "${index_args[@]}" >/dev/null 2>&1)
  if [[ -n "${PITLANE_EMBED_URL:-}" ]]; then
    echo "  Waiting for embedding generation (${PITLANE_EMBED_MODEL:-?} @ $PITLANE_EMBED_URL) ..."
    ("$CLI" wait-embeddings "$PROJECT" --timeout-secs 900 >/dev/null 2>&1) \
      && log "embeddings generated" \
      || warn "embedding generation incomplete — is the embedding server up? ($PITLANE_EMBED_URL)"
  fi
  log "index built for $PROJECT (excludes: ${EXCLUDES[*]})"
}

# Health check for the Unsloth Studio embedding server (:1235). Warn-only:
# indexing/search degrade to BM25 when it is down, so this must not hard-fail.
verify_embedding_server() {
  local key_file="${PITLANE_EMBED_API_KEY_FILE:-$HOME/.unsloth/harness.key}"
  local url="${PITLANE_EMBED_URL:-http://127.0.0.1:1235/v1/embeddings}"
  local base="${url%/v1/embeddings}"
  local kf
  kf="$(eval "printf '%s' \"$key_file\"")"
  if [[ ! -f "$kf" ]]; then
    warn "embedding server: API key file missing ($kf) — cannot authenticate"
    return 1
  fi
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
    -H "Authorization: Bearer $(tr -d '[:space:]' < "$kf")" "$base/v1/models" || true)"
  if [[ "$code" == "200" ]]; then
    log "embedding server: $base healthy (${PITLANE_EMBED_MODEL:-model unset})"
    return 0
  fi
  warn "embedding server not reachable at $base (HTTP $code)"
  warn "  start it with ~/Projects/unsloth/embedding.sh — semantic search falls back to BM25 until then"
  return 1
}

verify_integrations() {
  echo "  Verifying binaries..."
  local ok=0
  local total=8
  load_pitlane_env

  if [[ -x "$CLI" ]]; then
    log "CLI: $CLI ($("$CLI" --version 2>/dev/null | head -1))"
    ok=$((ok+1))
  else
    warn "CLI missing: $CLI — run .opencode/mcp/setup.sh first"
  fi

  if [[ -x "$SERVER_BIN" ]]; then
    log "server binary: $SERVER_BIN"
    ok=$((ok+1))
  else
    warn "server binary missing: $SERVER_BIN — run .opencode/mcp/setup.sh first"
  fi

  if [[ -x "$WRAPPER" ]] && head -1 "$WRAPPER" | grep -q python; then
    log "wrapper: $WRAPPER (python relay)"
    # Smoke test: the WRAPPER must answer server/discover itself with -32601
    # (that is the whole reason it exists — agy compatibility).
    local req='{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}'
    local resp
    if command -v timeout >/dev/null 2>&1; then
      resp="$(printf '%s\n' "$req" | timeout 5 "$WRAPPER" 2>/dev/null || true)"
    else
      resp="$(printf '%s\n' "$req" | "$WRAPPER" 2>/dev/null || true)"
    fi
    if printf '%s' "$resp" | grep -q -- "-32601"; then
      log "wrapper: answers server/discover with -32601 (agy-compatible)"
      ok=$((ok+1))
    else
      warn "wrapper: server/discover did not produce -32601 — relay broken?"
    fi
  else
    warn "wrapper missing at $WRAPPER — run .opencode/mcp/setup.sh first"
  fi

  ensure_local_bin_on_path

  echo ""
  echo "  Verifying embedding server..."
  if verify_embedding_server; then
    ok=$((ok+1))
  fi

  echo ""
  echo "  Verifying integrations..."
  if command -v opencode >/dev/null 2>&1; then
    if opencode mcp list 2>&1 | grep -q "pitlane.*connected"; then
      log "opencode: pitlane MCP connected"
      ok=$((ok+1))
    else
      warn "opencode: pitlane MCP not connected — check .opencode/opencode.json (restart opencode after install)"
    fi
  else
    warn "opencode not found in PATH"
  fi

  if command -v claude >/dev/null 2>&1; then
    if [[ -f "$MCP_DIR/pitlane.json" ]] && \
       echo "List the MCP tools from the pitlane server." | claude --print \
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

  if command -v agy >/dev/null 2>&1; then
    if [[ -f "$HOME/.gemini/antigravity-cli/mcp_config.json" ]] && \
       grep -q "pitlane" "$HOME/.gemini/antigravity-cli/mcp_config.json" 2>/dev/null; then
      log "agy: interactive MCP config entry present"
      ok=$((ok+1))
    else
      warn "agy: headless uses the wrapper; interactive agy needs a pitlane entry in ~/.gemini/antigravity-cli/mcp_config.json"
    fi
  else
    warn "agy not found in PATH"
  fi

  echo ""
  echo "  $ok/$total checks green."
}

uninstall() {
  rm -f "$WRAPPER" "$SERVER_BIN" "$CLI" "$ENV_INSTALLED"
  rm -rf "$INDEX_CACHE" 2>/dev/null || true
  echo "  Removed $LOCAL_BIN/{pitlane,pitlane-mcp,pitlane-mcp-bin}, $ENV_INSTALLED and $INDEX_CACHE."
}

# ── main ────────────────────────────────────────────────────────────────────
case "${1:-}" in
  --verify)   verify_integrations ;;
  --uninstall) uninstall ;;
  *)
  ensure_local_bin_on_path
  install_binaries
  install_wrapper
  sync_env_file
  build_index
    echo ""
    echo "  Done. pitlane-mcp is available to:"
    echo "    - opencode  (Manager + subagents, via .opencode/opencode.json)"
    echo "    - claude    (--mcp-config .opencode/mcp/pitlane.json)"
    echo "    - codex     (-c mcp_servers.pitlane.command=pitlane-mcp in the plugin)"
    echo "    - agy       (interactive via ~/.gemini/antigravity-cli/mcp_config.json;"
    echo "                 headless uses the discovery wrapper)"
    echo ""
    echo "  Next: .opencode/mcp/setup.sh --verify"
    ;;
esac