import { tool } from "@opencode-ai/plugin"
import { runCliAndSave } from "../lib/save-output"

export default tool({
  description:
    "Run OpenAI's authenticated Codex CLI non-interactively in the current workspace. It can inspect, edit, and execute commands. Optionally select any model accepted by the local Codex CLI.",
  args: {
    prompt: tool.schema.string().min(1).describe("The complete task for Codex"),
    model: tool.schema.string().min(1).optional().describe("Optional Codex model ID"),
  },
  async execute(args, context) {
    const commandArgs = [
      "exec",
      "-",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "--cd",
      context.directory,
      // Inject the local pitlane graph MCP server for this run only
      // (binary is shared at ~/.local/bin — resolved via PATH, no per-project copy).
      "-c",
      `mcp_servers.pitlane.command="pitlane-mcp"`,
    ]

    if (args.model) commandArgs.push("--model", args.model)

    return runCliAndSave({
      toolName: "cli-codex",
      sessionID: context.sessionID,
      prompt: args.prompt,
      options: {
        command: "codex",
        args: commandArgs,
        cwd: context.directory,
        stdin: args.prompt,
        signal: context.abort,
      },
    })
  },
})
