import { tool } from "@opencode-ai/plugin"
import { runCliAndSave } from "../lib/save-output"

export default tool({
  description:
    "Run Google's authenticated Antigravity coding agent (agy) non-interactively in the current workspace. It can inspect, edit, and execute commands. Optionally select any model exposed by the local agy installation.",
  args: {
    prompt: tool.schema.string().min(1).describe("The complete task for Antigravity"),
    model: tool.schema.string().min(1).optional().describe("Optional Antigravity model ID"),
    effort: tool.schema
      .enum(["low", "medium", "high"])
      .optional()
      .describe("Optional reasoning effort"),
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
    if (args.effort) commandArgs.push("--effort", args.effort)

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
