# opencode config -- Manager / CLI Agents

Quickly load this configuration into any project by cloning the repo into `.opencode/` at the project root. Opencode reads `opencode.json` from that directory, so no additional setup is needed.

This config sets up a primary **Manager** agent (runs on the model selected for the session — never the local model), with three external CLI coding-agent plugins (Claude Code, Codex, Antigravity), a local subagent (`qwen`), and a self-contained pitlane-mcp code-graph server.

## Runtime

This project is written in TypeScript and uses [Bun](https://bun.sh) as its runtime. The runtime dependencies are:

- `@opencode-ai/plugin` -- opencode's plugin SDK (provides the `tool()` helper used to register CLI agents).
- `bun:sqlite` -- Bun's built-in SQLite binding, used by `lib/save-output.ts` to look up session titles.
- Node.js stdlib (`node:path`, `node:fs`) for file I/O and path handling.

## Provider / Model

The **Manager** (default agent) runs on whichever model is selected for the session (e.g. an opencode cloud model). The local model is **reserved exclusively for the `qwen` subagent** — never for the Manager or as a session default.

The local model is served via an OpenAI-compatible endpoint at `http://proart-px13.local:1234/v1/` (provider `unsloth`). It supports tool calling, reasoning, and image input: Qwen 3.8 27B (multimodal text+vision, 131,072-token loaded context / 262,144 max).

## Agents

| Agent | Mode | Role |
| --- | --- | --- |
| `Manager` (default) | primary | Entry point for all work. Runs on the session model (not the local model). Leads research and analysis, manages multi-step tasks, decides when to delegate to CLI agents or the local subagent. |
| `qwen` | subagent | Qwen 3.8 27B (subagent-only) — large-scope mechanical edits, long-context token-heavy work, local MCP tool use. Does not spawn further subagents. |

Agent prompts are defined in `agents/Manager.md` and `agents/qwen.md`. The Manager agent contains the full reference of valid model IDs for each external CLI agent (Claude Code, Codex, Antigravity).

## Plugins (CLI agents)

Three opencode plugins register external coding agents that can be invoked as tools:

| Plugin | CLI binary | Description |
| --- | --- | --- |
| `tools/cli-claude.ts` | `claude` | Anthropic Claude Code. Accepts `prompt`, optional `model`, and `effort` (`low`/`medium`/`high`/`xhigh`/`max`). |
| `tools/cli-codex.ts` | `codex` | OpenAI Codex CLI. Accepts `prompt` and optional `model`. Runs non-interactively with `--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral`. |
| `tools/cli-antigravity.ts` | `agy` | Google Antigravity (`agy`). Accepts `prompt` and optional `model`. Reasoning effort is encoded in the model ID suffix (e.g. `gemini-3.7-flash-high`); there is no separate effort arg. |

All three plugins run the external CLI non-interactively in the current workspace directory, pipe the task as stdin or a `--print` argument, and save their output via `lib/save-output.ts`.

## Unsloth Deep Research tools

The Unsloth UI Backend (`unsloth-cli` on the LAN host) exposes the same agentic stack as Unsloth Desktop, including a full **Deep Research** subsystem (`/api/chat/research-runs/*`) with a plan → approve → execute workflow, a tool-confirm gate, execution sandboxes, and an SSE event stream. Two tools in `tools/` expose this to agents; they talk HTTP to the backend using the same `API_KEY` as the model provider (see `lib/unsloth.ts`):

| Tool | Purpose |
| --- | --- |
| `tools/unsloth-deep-research.ts` | One-shot research runner. Creates a chat thread + user message + research run, waits for the plan, **auto-approves** it, and polls until the research completes. Returns the final report with citations, sources, steps, and the event log. Args: `prompt` (required), optional `instructions`, `title`, `maxSteps`, `maxSources`, `maxWaitSeconds` (default 180, max 600). |
| `tools/unsloth-research.ts` | Low-level control tool with an `action` enum: `start` (create run, returns `run_id`), `status` (by `run_id` or active runs by `thread_id`, shows the plan + approval instructions), `events` (raw SSE event stream), `approve` (approves the plan, auto-uses the run's revision/hash), `cancel`. |

Both tools first ensure `deepResearchEnabled` + `toolsEnabled` + `webFetchToolsEnabled` are on in `/api/chat/settings` so the backend is ready even after a restart.

The research run lifecycle (verified live on the backend): `created → planning → awaiting_approval → (approve) → queued → running → completed`. A real run takes roughly 1.5–2.5 minutes for a simple question; up to 12 steps / 40 sources by default. The final answer lives in the run's `report` field; the thread also gets an assistant message with the full reasoning + report.

## Codebase graph (pitlane MCP)

`mcp/` contains a self-contained [pitlane-mcp](https://github.com/eresende/pitlane-mcp) setup — a local tree-sitter graph of the project exposed as MCP tools (`pitlane_investigate`, `pitlane_locate_code`, `pitlane_read_code_unit`, `pitlane_trace_path`, `pitlane_analyze_impact`, ...). It is registered for:

- **opencode** — `mcp.pitlane` in `opencode.json` (available to Manager and `qwen`)
- **Claude Code** — `--mcp-config` in the `cli-claude` plugin
- **Codex** — run-scoped `-c` override in the `cli-codex` plugin
- **Antigravity** — interactive agy works via the discovery wrapper (entry in `~/.gemini/antigravity-cli/mcp_config.json`); the headless `cli-antigravity` tool is **not wired** because agy headless ignores `mcp_config.json` on ≥1.1.14 (see `mcp/README.md`)

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
│   └── qwen.md       # Local subagent prompt (Qwen 3.8 27B)
├── lib/              # Shared TypeScript utilities (Bun runtime)
│   ├── run-cli.ts    # Shell command runner via Bun.spawn
│   ├── save-output.ts  # CLI output capture and Markdown file writer
│   └── unsloth.ts    # Unsloth UI Backend HTTP client + run/event helpers
├── mcp/              # Self-contained pitlane-mcp code-graph setup
│   ├── pitlane-mcp-wrapper.py  # discovery-aware stdio relay (installed as pitlane-mcp)
│   ├── pitlane.json  # MCP server def for claude --mcp-config
│   ├── setup.sh      # idempotent install / index / verify / uninstall
│   └── README.md
├── tools/            # opencode plugin entry points for external CLIs + Unsloth tools
│   ├── cli-claude.ts
│   ├── cli-codex.ts
│   ├── cli-antigravity.ts
│   ├── unsloth-deep-research.ts
│   └── unsloth-research.ts
├── outputs/          # Saved tool runs (Markdown, keyed by session)
├── .gitignore
├── opencode.json     # opencode configuration: provider, plugins, agents, MCP
└── README.md
```

## Configuration file

`opencode.json` is the sole opencode config. It declares:

- The `$schema` URL for validation.
- `default_agent`: `"Manager"`.
- `provider.unsloth`: the local model provider (Qwen 3.8 27B), used **only** by the `qwen` subagent (npm package `@ai-sdk/openai-compatible`, local base URL, API key, and per-model capabilities/limits). The Manager never runs on this model.
- `mcp.pitlane`: the local pitlane-mcp code-graph server (shared `pitlane-mcp` binary in `~/.local/bin`, resolved via PATH — see `mcp/README.md`).
- `agent`: agents are defined as markdown files in `agents/` — `Manager` with mode `primary`, and the `qwen` subagent. Tool plugins (`cli-claude.ts`, `cli-codex.ts`, `cli-antigravity.ts`) are auto-discovered from `tools/`.

## Saving output

When a CLI agent runs, its stdout/stderr is written to `outputs/<sanitized-session-title>/<tool-name>-<ISO-timestamp>.md`. Each file contains the session title/ID, tool name, timestamp, the original prompt, and the captured output. The Manager agent verifies delegated work before presenting results -- it should not delegate merely to avoid doing necessary synthesis itself (see `agents/Manager.md:91`).
