# opencode config -- Manager / CLI Agents

Quickly load this configuration into any project by cloning the repo into `.opencode/` at the project root. Opencode reads `opencode.json` from that directory, so no additional setup is needed.

This config sets up a primary **Manager** agent backed by the local Ornith 1.0 35B model, with three external CLI coding-agent plugins (Claude Code, Codex, Antigravity) and a background subagent (`bga`).

## Runtime

This project is written in TypeScript and uses [Bun](https://bun.sh) as its runtime. The runtime dependencies are:

- `@opencode-ai/plugin` -- opencode's plugin SDK (provides the `tool()` helper used to register CLI agents).
- `bun:sqlite` -- Bun's built-in SQLite binding, used by `lib/save-output.ts` to look up session titles.
- Node.js stdlib (`node:path`, `node:fs`) for file I/O and path handling.

## Provider / Model

The default agent runs on **Ornith 1.0 35B** (proart-lms provider) via an OpenAI-compatible endpoint at `http://proart-px13.local:1234/v1/`. The model supports tool calling and reasoning, with a context window of ~262k tokens and output ceiling of 16k tokens.

## Agents

| Agent | Mode | Role |
| --- | --- | --- |
| `Manager` (default) | primary | Entry point for all work. Leads research and analysis, manages multi-step tasks, decides when to delegate to CLI agents or the bga subagent. |
| `bga` | subagent | Background agent that handles delegated concrete tasks -- multi-file edits, debugging, repo-wide reasoning, and local MCP tool use. Does not spawn further subagents. |

Agent prompts are defined in `agents/Manager.md` and `agents/bga.md`. The Manager agent contains the full reference of valid model IDs for each external CLI agent (Claude Code, Codex, Antigravity).

## Plugins (CLI agents)

Three opencode plugins register external coding agents that can be invoked as tools:

| Plugin | CLI binary | Description |
| --- | --- | --- |
| `tools/cli-claude.ts` | `claude` | Anthropic Claude Code. Accepts `prompt`, optional `model`, and `effort` (`low`/`medium`/`high`/`xhigh`/`max`). |
| `tools/cli-codex.ts` | `codex` | OpenAI Codex CLI. Accepts `prompt` and optional `model`. Runs non-interactively with `--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral`. |
| `tools/cli-antigravity.ts` | `agy` | Google Antigravity (`agy`). Accepts `prompt` and optional `model`. Reasoning effort is encoded in the model ID suffix (e.g. `gemini-3.7-flash-high`); there is no separate effort arg. |

All three plugins run the external CLI non-interactively in the current workspace directory, pipe the task as stdin or a `--print` argument, and save their output via `lib/save-output.ts`.

## Library modules

| File | Purpose |
| --- | --- |
| `lib/run-cli.ts` | Spawns arbitrary shell commands via `Bun.spawn`, captures stdout/stderr/exit code. Used as the execution backbone for every CLI agent plugin. |
| `lib/save-output.ts` | Runs a CLI command and writes its output (along with prompt, session title, timestamp) to a Markdown file under `outputs/<session-folder>/`. Looks up the human-readable session title from opencode's SQLite database (`opencode.db`). Throws if the process exits non-zero. |

## Directory structure

```
.
├── agents/           # Agent system prompts (YAML frontmatter + prose)
│   ├── Manager.md    # Primary orchestrator agent prompt
│   └── bga.md        # Background subagent prompt
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
- `provider.proart-lms`: the Ornith model provider (npm package `@ai-sdk/openai-compatible`, local base URL, API key, and per-model capabilities/limits).
- `plugin`: array of three tool plugins (`cli-claude.ts`, `cli-codex.ts`, `cli-antigravity.ts`).
- `agent`: definitions for the two agents (`Manager` with mode `primary`, and `bga`).

## Saving output

When a CLI agent runs, its stdout/stderr is written to `outputs/<sanitized-session-title>/<tool-name>-<ISO-timestamp>.md`. Each file contains the session title/ID, tool name, timestamp, the original prompt, and the captured output. The Manager agent verifies delegated work before presenting results -- it should not delegate merely to avoid doing necessary synthesis itself (see `agents/Manager.md:91`).
