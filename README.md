# opencode config -- Manager / CLI Agents

Quickly load this configuration into any project by cloning the repo into `.opencode/` at the project root. Opencode reads `opencode.json` from that directory, so no additional setup is needed.

This config sets up a primary **Manager** agent (runs on the model selected for the session), with two external CLI coding-agent plugins (Codex, Antigravity), and a self-contained pitlane-mcp code-graph server.

## Runtime

This project is written in TypeScript and runs on [Bun](https://bun.sh), which is the runtime OpenCode itself embeds. There is nothing to install and no `package.json` step: the plugins declare only local structural types, so cloning this directory into a project is sufficient.

Runtime dependencies:

- `bun:sqlite` -- Bun's built-in SQLite binding, used by `lib/save-output.ts` to look up session titles.
- Node.js stdlib (`node:path`, `node:fs`) for file I/O and path handling.

## Provider / Model

The **Manager** (default agent) runs on whichever model is selected for the session (e.g. an opencode cloud model).

## Agents

| Agent | Mode | Role |
| --- | --- | --- |
| `Manager` (default) | primary | Entry point for all work. Runs on the session model. Leads research and analysis, manages multi-step tasks, decides when to delegate to CLI agents. |

Agent prompts are defined in `agents/Manager.md`. The Manager agent contains the full reference of valid model IDs for each external CLI agent (Codex, Antigravity).

## Plugins (CLI agents)

OpenCode V2 registers custom tools through **plugins**, not standalone tool files. V2 discovers local plugins only from `.opencode/plugin/` and `.opencode/plugins/`; the V1 `.opencode/tool/` directory is no longer scanned. Each plugin default-exports a `{ id, setup(ctx) }` definition and registers its tool with `ctx.tool.transform(...)`, declaring the input as JSON Schema and returning `{ content }`.

| Plugin | CLI binary | Description |
| --- | --- | --- |
| `plugins/cli-antigravity.ts` | `agy` | Google Antigravity (`agy`). Accepts `prompt` and optional `model`. Runs non-interactively with `--print --dangerously-skip-permissions --add-dir <workspace>`. Reasoning effort is encoded in the model ID suffix (e.g. `gemini-3.7-flash-high`); there is no separate effort arg. |
| `tools/cli-codex.ts` | `codex` | **Not loaded by OpenCode V2.** Still a V1 tool file that must be ported to the plugin API before `cli-codex` will register. |

Plugins run the external CLI non-interactively in the workspace directory (`ctx.location.directory`), pass the task as a `--print` argument, and save output via `lib/save-output.ts`.

## Codebase graph (pitlane MCP)

`mcp/` contains a self-contained [pitlane-mcp](https://github.com/eresende/pitlane-mcp) setup — a local tree-sitter graph of the project exposed as MCP tools (`pitlane_investigate`, `pitlane_locate_code`, `pitlane_read_code_unit`, `pitlane_trace_path`, `pitlane_analyze_impact`, ...). It is registered for:

- **opencode** — `mcp.pitlane` in `opencode.json` (available to Manager)
- **Codex** — run-scoped `-c` override in the `cli-codex` plugin
- **Antigravity** — registered via the `agy` discovery wrapper installed by `mcp/setup.sh` (see `cli-antigravity.ts`).

Everything lives inside `.opencode/mcp/` — no global `~/.codex/config.toml` changes. Run `.opencode/mcp/setup.sh` once per machine: it installs the shared binaries to `~/.local/bin/` (no per-project download) and indexes the project. See `mcp/README.md` for details.

## Library modules

| File | Purpose |
| --- | --- |
| `lib/run-cli.ts` | Spawns arbitrary shell commands via `Bun.spawn`, captures stdout/stderr/exit code. Used as the execution backbone for every CLI agent plugin. |
| `lib/save-output.ts` | Runs a CLI command and writes its output (along with prompt, session title, timestamp) to a Markdown file under `outputs/<session-folder>/`. Looks up the human-readable session title from opencode's SQLite database (`opencode.db`). Throws if the process exits non-zero. |

## Directory structure

```tree
.
├── agents/           # Agent system prompts (YAML frontmatter + prose)
│   └── Manager.md    # Primary orchestrator agent prompt
├── lib/              # Shared TypeScript utilities (Bun runtime)
│   ├── run-cli.ts    # Shell command runner via Bun.spawn
│   └── save-output.ts  # CLI output capture and Markdown file writer
├── mcp/              # Self-contained pitlane-mcp code-graph setup
│   ├── pitlane-mcp-wrapper.py  # discovery-aware stdio relay (installed as pitlane-mcp)
│   ├── pitlane.json  # MCP server def (legacy)
│   ├── setup.sh      # idempotent install / index / verify / uninstall
│   └── README.md
├── plugins/          # OpenCode V2 plugins (auto-discovered, register tools)
│   └── cli-antigravity.ts
├── tools/            # legacy OpenCode V1 tool files — NOT loaded by V2
│   └── cli-codex.ts
├── outputs/          # Saved tool runs (Markdown, keyed by session)
├── .gitignore
├── opencode.json     # opencode configuration: provider, plugins, agents
└── README.md
```

## Configuration file

`opencode.json` is the sole opencode config. It declares:

- The `$schema` URL for validation.
- `default_agent`: `"Manager"`.
- `mcp.pitlane`: the local pitlane-mcp code-graph server (shared `pitlane-mcp` binary in `~/.local/bin`, resolved via PATH — see `mcp/README.md`).
- `agent`: agents are defined as markdown files in `agents/` — `Manager` with mode `primary`. Plugins that register tools (`plugins/cli-antigravity.ts`) are auto-discovered from `plugins/`.

## Saving output

When a CLI agent runs, its stdout/stderr is written to `outputs/<sanitized-session-title>/<tool-name>-<ISO-timestamp>.md`. Each file contains the session title/ID, tool name, timestamp, the original prompt, and the captured output. The Manager agent verifies delegated work before presenting results -- it should not delegate merely to avoid doing necessary synthesis itself (see `agents/Manager.md:91`).
