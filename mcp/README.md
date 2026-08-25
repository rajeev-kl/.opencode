# pitlane-mcp — code intelligence for every agent

Shared tree-sitter symbol + call-graph index served over MCP. One install per
machine (`~/.local/bin/`), one index cache per project (`~/.pitlane/indexes/`),
wired into opencode / claude / codex / agy.

## Layout

| Path | What |
| ---- | ---- |
| `~/.local/bin/pitlane` | CLI (index / search / stats / investigate / …) |
| `~/.local/bin/pitlane-mcp-bin` | real pitlane-mcp server binary |
| `~/.local/bin/pitlane-mcp` | python wrapper (discovery interception + env injection) |
| `~/.pitlane/env` | machine-local copy of this dir's `pitlane.env` |
| `~/.pitlane/indexes/<hash>/` | per-project index (`index.bin`, `embeddings.bin`) |
| `<repo>/.opencode/mcp/pitlane.env` | source of truth for semantic-search config |

The wrapper exists because agy sends `server/discover` before `initialize`
(pitlane answers it by closing the connection); the wrapper replies `-32601`
so agy falls back to the standard flow, and relays everything else
transparently. It also loads `~/.pitlane/env` into the server process
environment so every client gets identical config.

## Commands

```bash
.opencode/mcp/setup.sh            # install binaries + build index for CWD project
.opencode/mcp/setup.sh --verify   # binaries, wrapper relay, embedding server, client integrations
.opencode/mcp/setup.sh --uninstall
```

`PITLANE_INDEX_FORCE=1` forces a full rebuild. Excludes default to
`not-used/** extra/** .venv/** node_modules/**`; override with
`PITLANE_EXCLUDES="glob1 glob2"`.

## Semantic search

Hybrid ranking (vector + BM25) is enabled when an embedding endpoint is
configured in `pitlane.env`. Current setup:

- **Server:** Unsloth Studio instance on `127.0.0.1:1235` running Google
  embeddinggemma-300M (Q8_0 GGUF, 768-dim). Launched by
  `~/Projects/unsloth/embedding.sh` — start it **after** `qwen.sh`
  (`qwen.sh` runs `unsloth studio stop`, which kills every Studio instance,
  embedding server included).
- **Auth:** single static key shared by both Studio instances; resolved at
  runtime from `PITLANE_EMBED_API_KEY_FILE` (`~/.unsloth/harness.key`). Never
  commit key material to the repo.
- **Prefixes:** embeddinggemma task instructions are passed via
  `PITLANE_EMBED_QUERY_PREFIX` / `PITLANE_EMBED_DOCUMENT_PREFIX`
  (trailing spaces are significant).
- **Index-time:** `setup.sh` sources the env and blocks on
  `pitlane wait-embeddings` after indexing. Full rebuild + embed of this repo
  ≈ 2 minutes.
- **Query-time:** the MCP server embeds queries through the same endpoint;
  if :1235 is down, ranking degrades to BM25 (no hard failure).

CLI usage:

```bash
set -a; source ~/.pitlane/env; set +a
export PITLANE_EMBED_API_KEY="$(cat ~/.unsloth/harness.key)"
pitlane search . "how does webhook intake work" --mode semantic
```

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `--mode semantic` returns bm25-ranked results | Embedding server down → `~/Projects/unsloth/embedding.sh`, then re-run `setup.sh` (or call `ensure_project_ready` twice) to regenerate missing vectors |
| `input (N tokens) is too large to process` in logs | Server physical batch too small — keep `-b 4096 -ub 4096` flags in `embedding.sh` |
| Index contains `not-used/` files | Stale pre-exclude index → `PITLANE_INDEX_FORCE=1 .opencode/mcp/setup.sh` |
| opencode reports pitlane disconnected | Restart opencode after (re)installing binaries |
| Embeddings regenerate from scratch repeatedly | `PITLANE_EMBED_*` values changed → fingerprint mismatch is expected; revert or accept the one-time rebuild |
