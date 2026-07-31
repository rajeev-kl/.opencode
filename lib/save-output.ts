import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"
import { runCli, type RunOptions } from "./run-cli"

export type CliRunInput = {
  toolName: string
  sessionID: string
  prompt: string
  options: RunOptions
}

export async function runCliAndSave(input: CliRunInput): Promise<string> {
  const result = await runCli(input.options)
  const filePath = saveOutput({
    toolName: input.toolName,
    sessionID: input.sessionID,
    prompt: input.prompt,
    output: formatResult(input.options.command, result),
  })

  if (result.exitCode !== 0) {
    throw new Error(
      `${input.options.command} exited with code ${result.exitCode}${
        result.stderr ? `:\n${result.stderr}` : ""
      }\n\nOutput saved to: ${filePath}`,
    )
  }

  return `${formatResult(input.options.command, result)}\n\nOutput saved to: ${filePath}`
}

export type SaveOutputInput = {
  toolName: string
  sessionID: string
  prompt: string
  output: string
}

export function saveOutput(input: SaveOutputInput): string {
  const title = getSessionTitle(input.sessionID) ?? input.sessionID
  const folder = sanitizeFolderName(title)
  const timestamp = timestampForFilename()
  const filename = `${input.toolName}-${timestamp}.md`

  const outputsDir = path.resolve(import.meta.dir, "../outputs")
  const dir = path.join(outputsDir, folder)
  const filePath = path.join(dir, filename)

  mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, renderMarkdown({ ...input, title, timestamp }), "utf-8")

  return filePath
}

function formatResult(command: string, result: { exitCode: number; stdout: string; stderr: string }): string {
  return (
    result.stdout ||
    result.stderr ||
    `${command} completed successfully with no output.`
  )
}

function renderMarkdown(input: SaveOutputInput & { title: string; timestamp: string }): string {
  return [
    `# ${input.toolName} output`,
    "",
    `- **Session:** ${input.title}`,
    `- **Session ID:** \`${input.sessionID}\``,
    `- **Tool:** \`${input.toolName}\``,
    `- **Timestamp:** ${input.timestamp}`,
    "",
    "## Prompt",
    "```",
    input.prompt,
    "```",
    "",
    "## Output",
    "```",
    input.output,
    "```",
    "",
  ].join("\n")
}

function getSessionTitle(sessionID: string): string | null {
  try {
    const db = new Database(openCodeDbPath(), { readonly: true })
    try {
      const row = db
        .query<{ title: string }, string>("SELECT title FROM session WHERE id = ?")
        .get(sessionID)
      return row?.title ?? null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

function openCodeDbPath(): string {
  const home = Bun.env.HOME || "/"
  const dataHome = Bun.env.XDG_DATA_HOME || path.join(home, ".local", "share")
  return path.join(dataHome, "opencode", "opencode.db")
}

function sanitizeFolderName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim()
    .slice(0, 120)
  return cleaned || "untitled-session"
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}
