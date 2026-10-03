# opencode config -- Manager / CLI Agents

Quickly load this configuration into any project by cloning the repo into `.opencode/` at the project root. Opencode reads `opencode.json` from that directory, so no additional setup is needed.

This config sets up a primary **Manager** agent (runs on the model selected for the session — never the local model), with three external CLI coding-agent plugins (Claude Code, Codex, Antigravity), three local subagents (`qwen`, `qwen-flash`, `ornith`), and a self-contained pitlane-mcp code-graph server.

## Runtime

This project is written in TypeScript and uses [Bun](https://bun.sh) as its runtime. The runtime dependencies are:

- `@opencode/plugin` -- opencode's v2 plugin SDK (provides `Plugin.define` / `ctx.tool.transform` used to register CLI agents).
- `bun:sqlite` -- Bun's built-in SQLite binding, used by `lib/save-output.ts` to look up session titles.
- Node.js stdlib (`node:path`, `node:fs`) for file I/O and path handling.

## Provider / Model

The **Manager** (default agent) runs on whichever model is selected for the session (e.g. an opencode cloud model). The local models are **reserved exclusively for the `qwen` / `qwen-flash` / `ornith` subagents**.

Three OpenAI-compatible endpoints exist across two hosts — each server loads only one model at a time, and the hosts are independent and can serve concurrently:

- provider `unsloth` — `http://proart-px13.local:1234/v1/`: Qwen 3.8 27B (tool calling, reasoning, image input; 262,144-token loaded context / 262,144 max). Used by `qwen`.
- provider `unsloth-peladn` — `http://Peladn-YO2.local:1234/v1/`: Qwen3.8 Flash Next UD Q4_K_XL (reasoning model; 262,144 context; **no vision projector loaded** — text-only in practice). Used by `qwen-flash`.
- provider `ornith` — `http://proart-px13.local:1234/v1/` (same endpoint and API key as `unsloth`): Ornith 1.5 35B A3B Q6_K, registered as `ornith-ai/Ornith-1.5-35B-A3B-GGUF`. Used by `ornith`. Shares the proart-px13 server with `unsloth` — **one of the two is loaded at a time** (loading `ornith` unloads `qwen`, and vice versa). Capabilities (vision projector, reasoning, exact context) are declared in config but unverified until the model is loaded.

## Agents

| Agent | Mode | Role |
| --- | --- | --- |
| `Manager` (default) | primary | Entry point for all work. Runs on the session model (not the local model). Leads research and analysis, manages multi-step tasks, decides when to delegate to CLI agents or the local subagent. |
| `qwen` | subagent | Qwen 3.8 27B (subagent-only) — large-scope mechanical edits, long-context token-heavy work, local MCP tool use. Does not spawn further subagents. |
| `qwen-flash` | subagent | Qwen3.8 Flash Next UD Q4_K_XL (subagent-only) — same role as `qwen`, on the second host (`unsloth-peladn`); 262,144-token context, text-only. Does not spawn further subagents. |
| `ornith` | subagent | Ornith 1.5 35B A3B (subagent-only) — same role as `qwen`, on the same proart-px13 host (`ornith` provider); shares the server with `qwen` (one model loaded at a time). Capabilities unverified until loaded. Does not spawn further subagents. |

Agent prompts are defined in `agents/Manager.md`, `agents/qwen.md`, `agents/qwen-flash.md`, and `agents/ornith.md`. The Manager agent contains the full reference of valid model IDs for each external CLI agent (Claude Code, Codex, Antigravity).

## Plugins (CLI agents)

One opencode v2 plugin (`plugins/cli-agents/`, id `cli-agents`) registers three external coding agents as tools:

| Tool | CLI binary | Description |
| --- | --- | --- |
| `cli-claude` | `claude` | Anthropic Claude Code. Accepts `prompt`, optional `model`, and `effort` (`low`/`medium`/`high`/`xhigh`/`max`). |
| `cli-codex` | `codex` | OpenAI Codex CLI. Accepts `prompt` and optional `model`. Runs non-interactively with `--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral`. |
| `cli-antigravity` | `agy` | Google Antigravity (`agy`). Accepts `prompt` and optional `model`. Reasoning effort is encoded in the model ID suffix (e.g. `gemini-3.7-flash-high`); there is no separate effort arg. |

All three plugins run the external CLI non-interactively in the current workspace directory, pipe the task as stdin or a `--print` argument, and save their output via `lib/save-output.ts`.

## Codebase graph (pitlane MCP)

`mcp/` contains a self-contained [pitlane-mcp](https://github.com/eresende/pitlane-mcp) setup — a local tree-sitter graph of the project exposed as MCP tools (`pitlane_investigate`, `pitlane_locate_code`, `pitlane_read_code_unit`, `pitlane_trace_path`, `pitlane_analyze_impact`, ...). It is registered for:

- **opencode** — `mcp.pitlane` in `opencode.json` (available to Manager and `qwen`)
- **Claude Code** — `--mcp-config` in the `cli-claude` plugin
- **Codex** — run-scoped `-c` override in the `cli-codex` plugin
- **Antigravity** — registered via the `agy` discovery wrapper installed by `mcp/setup.sh` (see `plugins/cli-agents/index.ts`).

Everything lives inside `.opencode/mcp/` — no global `~/.claude.json` / `~/.codex/config.toml` changes. Run `.opencode/mcp/setup.sh` once per machine: it installs the shared binaries to `~/.local/bin/` (no per-project download) and indexes the project. See `mcp/README.md` for details.

## Library modules

| File | Purpose |
| --- | --- |
| `lib/run-cli.ts` | Spawns arbitrary shell commands via `Bun.spawn`, captures stdout/stderr/exit code. Used as the execution backbone for every CLI agent plugin. |
| `lib/save-output.ts` | Runs a CLI command and writes its output (along with prompt, session title, timestamp) to a Markdown file under `outputs/<session-folder>/`. Looks up the human-readable session title from opencode's SQLite database (`opencode.db`). Throws if the process exits non-zero. |

## Directory structure

```tree
.
├── agents/           # Agent system prompts (YAML frontmatter + prose)
│   ├── Manager.md    # Primary orchestrator agent prompt
│   ├── qwen.md       # Local subagent prompt (Qwen 3.8 27B)
│   ├── qwen-flash.md # Local subagent prompt (Qwen3.8 Flash Next, Peladn-YO2)
│   └── ornith.md     # Local subagent prompt (Ornith 1.5 35B A3B)
├── lib/              # Shared TypeScript utilities (Bun runtime)
│   ├── run-cli.ts    # Shell command runner via Bun.spawn
│   ├── save-output.ts  # CLI output capture and Markdown file writer
│   └── unsloth.ts    # Unsloth UI Backend HTTP client + run/event helpers
├── mcp/              # Self-contained pitlane-mcp code-graph setup
│   ├── pitlane-mcp-wrapper.py  # discovery-aware stdio relay (installed as pitlane-mcp)
│   ├── pitlane.json  # MCP server def for claude --mcp-config
│   ├── setup.sh      # idempotent install / index / verify / uninstall
│   └── README.md
├── plugins/          # v2 plugin entry points (auto-discovered)
│   └── cli-agents/index.ts  # registers cli-claude / cli-codex / cli-antigravity tools
├── outputs/          # Saved tool runs (Markdown, keyed by session)
├── .gitignore
├── opencode.json     # opencode configuration: provider, plugins, agents
└── README.md
```

## Configuration file

`opencode.json` is the sole opencode config. It declares:

- The `$schema` URL for validation.
- `default_agent`: `"Manager"`.
- `provider.unsloth`: the local model provider (Qwen 3.8 27B), used **only** by the `qwen` subagent (npm package `@ai-sdk/openai-compatible`, local base URL, API key, and per-model capabilities/limits). The Manager never runs on this model.
- `provider.ornith`: Ornith 1.5 35B A3B on the same `http://proart-px13.local:1234/v1/` endpoint and `{env:UNSLOTH_API_KEY}` as `unsloth`; used **only** by the `ornith` subagent.
- `mcp.pitlane`: the local pitlane-mcp code-graph server (shared `pitlane-mcp` binary in `~/.local/bin`, resolved via PATH — see `mcp/README.md`).
- `agent`: agents are defined as markdown files in `agents/` — `Manager` with mode `primary`, and the `qwen`, `qwen-flash`, and `ornith` subagents. The CLI agent tools (`cli-claude`, `cli-codex`, `cli-antigravity`) are registered by `plugins/cli-agents/`.

## Saving output

When a CLI agent runs, its stdout/stderr is written to `outputs/<sanitized-session-title>/<tool-name>-<ISO-timestamp>.md`. Each file contains the session title/ID, tool name, timestamp, the original prompt, and the captured output. The Manager agent verifies delegated work before presenting results -- it should not delegate merely to avoid doing necessary synthesis itself (see `agents/Manager.md:91`).
