# opencode config -- Manager / CLI Agents

Quickly load this configuration into any project by cloning the repo into `.opencode/` at the project root. Opencode reads `opencode.json` from that directory, so no additional setup is needed.

This config sets up a primary **Manager** agent (runs on the model selected for the session — never the local models), with three external CLI coding-agent plugins (Claude Code, Codex, Antigravity), two local subagents (`ornith`, `qwen`), and a self-contained pitlane-mcp code-graph server.

## Runtime

This project is written in TypeScript and uses [Bun](https://bun.sh) as its runtime. The runtime dependencies are:

- `@opencode-ai/plugin` -- opencode's plugin SDK (provides the `tool()` helper used to register CLI agents).
- `bun:sqlite` -- Bun's built-in SQLite binding, used by `lib/save-output.ts` to look up session titles.
- Node.js stdlib (`node:path`, `node:fs`) for file I/O and path handling.

## Provider / Model

The **Manager** (default agent) runs on whichever model is selected for the session (e.g. an opencode cloud model). The local models are **reserved exclusively for the `ornith` and `qwen` subagents** — never for the Manager or as a session default.

The local models are served via an OpenAI-compatible endpoint at `http://proart-px13.local:1234/v1/` (provider `proart-lms`, LM Studio). They support tool calling and reasoning: Ornith 1.0 35B (MoE, 102,400-token context) and Qwen 3.8 27B (dense, 102,400-token context).

## Agents

| Agent | Mode | Role |
| --- | --- | --- |
| `Manager` (default) | primary | Entry point for all work. Runs on the session model (not Ornith). Leads research and analysis, manages multi-step tasks, decides when to delegate to CLI agents or the local subagent. |
| `ornith` | subagent | Ornith 1.0 35B (subagent-only) — large-scope mechanical edits, long-context token-heavy work, local MCP tool use. Does not spawn further subagents. |
| `qwen` | subagent | Qwen 3.8 27B (subagent-only) — large-scope mechanical edits, long-context token-heavy work, local MCP tool use. Does not spawn further subagents. |

Agent prompts are defined in `agents/Manager.md`, `agents/ornith.md`, and `agents/qwen.md`. The Manager agent contains the full reference of valid model IDs for each external CLI agent (Claude Code, Codex, Antigravity).

## Plugins (CLI agents)

Three opencode plugins register external coding agents that can be invoked as tools:

| Plugin | CLI binary | Description |
| --- | --- | --- |
| `tools/cli-claude.ts` | `claude` | Anthropic Claude Code. Accepts `prompt`, optional `model`, and `effort` (`low`/`medium`/`high`/`xhigh`/`max`). |
| `tools/cli-codex.ts` | `codex` | OpenAI Codex CLI. Accepts `prompt` and optional `model`. Runs non-interactively with `--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral`. |
| `tools/cli-antigravity.ts` | `agy` | Google Antigravity (`agy`). Accepts `prompt` and optional `model`. Reasoning effort is encoded in the model ID suffix (e.g. `gemini-3.7-flash-high`); there is no separate effort arg. |

All three plugins run the external CLI non-interactively in the current workspace directory, pipe the task as stdin or a `--print` argument, and save their output via `lib/save-output.ts`.

## Codebase graph (pitlane MCP)

`mcp/` contains a self-contained [pitlane-mcp](https://github.com/eresende/pitlane-mcp) setup — a local tree-sitter graph of the project exposed as MCP tools (`pitlane_investigate`, `pitlane_locate_code`, `pitlane_read_code_unit`, `pitlane_trace_path`, `pitlane_analyze_impact`, ...). It is registered for:

- **opencode** — `mcp.pitlane` in `opencode.json` (available to Manager, `ornith`, `qwen`)
- **Claude Code** — `--mcp-config` in the `cli-claude` plugin
- **Codex** — run-scoped `-c` override in the `cli-codex` plugin

Everything lives inside `.opencode/mcp/` — no global `~/.claude.json` / `~/.codex/config.toml` changes. Run `.opencode/mcp/setup.sh` once per machine to fetch the binary (git-ignored) and index the project. See `mcp/README.md` for details.

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
│   ├── ornith.md        # Local subagent prompt (Ornith 35B)
│   └── qwen.md       # Local subagent prompt (Qwen 3.8 27B)
├── lib/              # Shared TypeScript utilities (Bun runtime)
│   ├── run-cli.ts    # Shell command runner via Bun.spawn
│   └── save-output.ts  # CLI output capture and Markdown file writer
├── tools/            # opencode plugin entry points for external CLIs
│   ├── cli-claude.ts
│   ├── cli-codex.ts
│   └── cli-antigravity.ts
├── outputs/          # Saved tool runs (Markdown, keyed by session)
├── .gitignore
├── opencode.json     # opencode configuration: provider, plugins, agents
└── README.md
```

## Configuration file

`opencode.json` is the sole opencode config. It declares:

- The `$schema` URL for validation.
- `default_agent`: `"Manager"`.
- `provider.proart-lms`: the local LM Studio model provider (Ornith 1.0 35B and Qwen 3.8 27B), used **only** by the `ornith` and `qwen` subagents (npm package `@ai-sdk/openai-compatible`, local base URL, API key, and per-model capabilities/limits). The Manager never runs on these models.
- `mcp.pitlane`: the local pitlane-mcp code-graph server (workspace-relative command `.opencode/mcp/bin/pitlane-mcp`).
- `agent`: agents are defined as markdown files in `agents/` — `Manager` with mode `primary`, and the `ornith` / `qwen` subagents. Tool plugins (`cli-claude.ts`, `cli-codex.ts`, `cli-antigravity.ts`) are auto-discovered from `tools/`.

## Saving output

When a CLI agent runs, its stdout/stderr is written to `outputs/<sanitized-session-title>/<tool-name>-<ISO-timestamp>.md`. Each file contains the session title/ID, tool name, timestamp, the original prompt, and the captured output. The Manager agent verifies delegated work before presenting results -- it should not delegate merely to avoid doing necessary synthesis itself (see `agents/Manager.md:91`).
