import { tool } from "@opencode-ai/plugin"
import { runCliAndSave } from "../lib/save-output"

export default tool({
  description:
    "Run Anthropic's authenticated Claude Code agent non-interactively in the current workspace. It can inspect, edit, and execute commands. Optionally select any model accepted by the local Claude CLI.",
  args: {
    prompt: tool.schema.string().min(1).describe("The complete task for Claude Code"),
    model: tool.schema.string().min(1).optional().describe("Optional Claude model alias or full ID"),
    effort: tool.schema
      .enum(["low", "medium", "high", "xhigh", "max"])
      .optional()
      .describe("Optional reasoning effort"),
  },
  async execute(args, context) {
    const commandArgs = [
      "--print",
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
      "--add-dir",
      context.directory,
      "--mcp-config",
      ".opencode/mcp/pitlane.json",
    ]

    if (args.model) commandArgs.push("--model", args.model)
    if (args.effort) commandArgs.push("--effort", args.effort)

    return runCliAndSave({
      toolName: "cli-claude",
      sessionID: context.sessionID,
      prompt: args.prompt,
      options: {
        command: "claude",
        args: commandArgs,
        cwd: context.directory,
        stdin: args.prompt,
        signal: context.abort,
      },
    })
  },
})
