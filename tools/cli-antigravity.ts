import { tool } from "@opencode-ai/plugin"
import { runCliAndSave } from "../lib/save-output"

export default tool({
  description:
    "Run Google's authenticated Antigravity coding agent (agy) non-interactively in the current workspace. It can inspect, edit, and execute commands. Select any model exposed by the local agy installation. Note: reasoning effort is encoded in the model ID suffix (e.g. gemini-3.7-flash-high), so pass a full model ID to pick the effort level.",
  args: {
    prompt: tool.schema.string().min(1).describe("The complete task for Antigravity"),
    model: tool.schema.string().min(1).optional().describe("Optional Antigravity model ID (e.g. gemini-3.7-flash-high)"),
  },
  async execute(args, context) {
    const commandArgs = [
      "--print",
      args.prompt,
      "--dangerously-skip-permissions",
      "--add-dir",
      context.directory,
    ]

    if (args.model) commandArgs.push("--model", args.model)

    return runCliAndSave({
      toolName: "cli-antigravity",
      sessionID: context.sessionID,
      prompt: args.prompt,
      options: {
        command: "agy",
        args: commandArgs,
        cwd: context.directory,
        signal: context.abort,
      },
    })
  },
})
