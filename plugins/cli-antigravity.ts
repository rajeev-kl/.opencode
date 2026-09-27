import { runCliAndSave } from "../lib/save-output"

type CliAntigravityArgs = {
  prompt: string
  model?: string
}

// Minimal structural types for the slice of the V2 plugin context this plugin
// uses. Declared locally so the plugin stays dependency-free: it ships as a
// drop-in `.opencode/` config with no install step. At runtime OpenCode's
// plugin loader accepts the plain `{ id, setup }` definition object that
// `Plugin.define()` produces (its implementation is the identity function), so
// importing `@opencode/plugin` is not required.
type ToolExecuteContext = {
  sessionID: string
  signal: AbortSignal
}

type ToolEditor = {
  add(tool: {
    name: string
    description: string
    input: Record<string, unknown>
    execute: (
      input: unknown,
      context: ToolExecuteContext,
    ) => Promise<{ content: string }>
  }): void
}

type PluginContext = {
  location: { directory: string }
  tool: {
    transform(callback: (editor: ToolEditor) => void): Promise<unknown>
  }
}

type PluginDefinition = {
  id: string
  setup(ctx: PluginContext): Promise<void>
}

export default {
  id: "cli-antigravity",

  async setup(ctx: PluginContext) {
    // V2 tool executors do not receive a directory; the plugin's load location
    // is the workspace the external CLI should operate in.
    const directory = ctx.location.directory

    await ctx.tool.transform((editor: ToolEditor) => {
      editor.add({
        name: "cli-antigravity",
        description:
          "Run Google's authenticated Antigravity coding agent (agy) non-interactively in the current workspace. It can inspect, edit, and execute commands. Select any model exposed by the local agy installation. Note: reasoning effort is encoded in the model ID suffix (e.g. gemini-3.7-flash-high), so pass a full model ID to pick the effort level.",
        input: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              minLength: 1,
              description: "The complete task for Antigravity",
            },
            model: {
              type: "string",
              minLength: 1,
              description: "Optional Antigravity model ID (e.g. gemini-3.7-flash-high)",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        async execute(input: unknown, context: ToolExecuteContext) {
          const args = input as CliAntigravityArgs
          const commandArgs = [
            "--print",
            args.prompt,
            "--dangerously-skip-permissions",
            "--add-dir",
            directory,
          ]

          if (args.model) commandArgs.push("--model", args.model)

          const output = await runCliAndSave({
            toolName: "cli-antigravity",
            sessionID: context.sessionID,
            prompt: args.prompt,
            options: {
              command: "agy",
              args: commandArgs,
              cwd: directory,
              // V2 exposes an AbortSignal; V1 called this `context.abort`.
              signal: context.signal,
            },
          })

          return { content: output }
        },
      })
    })
  },
} satisfies PluginDefinition
