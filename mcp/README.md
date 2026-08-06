# pitlane-mcp — local codebase graph

A self-contained [pitlane-mcp](https://github.com/eresende/pitlane-mcp) (Apache-2.0 / MIT) setup that gives every agent in this opencode config **tree-sitter symbol + call-graph intelligence** for the project — the same benefit GrapeRoot sells, without a closed-source engine, telemetry, or launcher config churn.

## What's here

```
mcp/
├── bin/            # pitlane-mcp + pitlane binaries (git-ignored, fetched by setup.sh)
├── pitlane.json    # MCP server definition consumed by claude --mcp-config
├── setup.sh        # idempotent install / index / verify / uninstall
└── README.md       # this file
```

## How it's wired (no global config mutation)

| Consumer | Mechanism | Config location |
| -------- | --------- | --------------- |
| opencode (Manager, o35, o9) | `mcp.pitlane` local server | `.opencode/opencode.json` |
| Claude Code (`cli-claude` tool) | `--mcp-config .opencode/mcp/pitlane.json` | `.opencode/tools/cli-claude.ts` |
| Codex CLI (`cli-codex` tool) | `-c mcp_servers.pitlane.command=...` (run-scoped) | `.opencode/tools/cli-codex.ts` |

Every registration points **inside `.opencode/mcp/`** — nothing is written to `~/.claude.json`, `~/.codex/config.toml`, or a project-root `opencode.json`. The graph index is runtime cache under `~/.pitlane/indexes/` (keyed by project path hash); pitlane-mcp has no config override for that location, and it rebuilds incrementally.

## Setup

```bash
.opencode/mcp/setup.sh                # download binary + index the project
.opencode/mcp/setup.sh <project-dir>  # index a specific directory
.opencode/mcp/setup.sh --verify       # check opencode + claude + codex integrations
.opencode/mcp/setup.sh --uninstall    # remove binary + index cache
```

Requires `curl`, `tar` (or `unzip` on Windows), and network access to GitHub Releases on first run. Pinned to `PITLANE_VERSION` in `setup.sh`.

> **Stale/polluted index → force rebuild.** `setup.sh` runs `pitlane index`
> **without `--force`**, and the CLI loads the existing index from cache when it
> is up to date. A re-run of `setup.sh` will therefore **not** rebuild an index
> that was created with the wrong excludes (e.g. by `pitlane_ensure_project_ready`
> with no `exclude` args — built-in defaults do **not** cover `not-used/`). If the
> graph contains files it shouldn't (check `workspace_roots` in
> `pitlane_get_index_stats`), rebuild explicitly:
>
> ```bash
> .opencode/mcp/bin/pitlane index . --force --exclude "not-used/**" --exclude "extra/**"
> ```
>
> Always pass `exclude` args to `pitlane_ensure_project_ready` in a session so the
> index is never rebuilt without them.

## Agent usage

Agents are instructed to prefer the `pitlane_` tools over broad grep/glob for symbol, call-structure, and impact questions (see `agents/Manager.md`, `agents/o35.md`, `agents/o9.md`). Core tools:

- `pitlane_ensure_project_ready` — first call of a session; ensures the index exists
- `pitlane_investigate` — broad subsystem / behavior / execution-path questions
- `pitlane_locate_code` — discovery without full source
- `pitlane_read_code_unit` — read one symbol precisely
- `pitlane_trace_path` — source-to-sink questions
- `pitlane_analyze_impact` — blast radius before edits/refactors
- `pitlane_search_content` — text fragment → owning symbol
- `pitlane_get_index_stats` — index sanity check

## Notes & limits

- **Java is first-class**; SQL migrations and Terraform (HCL) are not indexed — AGENTS.md covers those.
- **BM25 symbol search by default.** Semantic search is optional (`PITLANE_*` embedding vars, local or hosted embedders) but not enabled here.
- pitlane-mcp is in maintenance mode (feature-complete, Apache-2.0/MIT).
- For a full reference see [pitlane docs](https://github.com/eresende/pitlane-mcp).
