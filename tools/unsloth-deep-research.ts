import { tool } from "@opencode-ai/plugin"
import { unslothRequest, sleep, summarizeRun } from "../lib/unsloth"

/**
 * One-shot Deep Research runner against the Unsloth UI Backend
 * (unsloth-cli on the LAN host). Handles the full lifecycle:
 *
 *   create thread -> post user message -> create research run
 *   -> poll -> approve plan (when ready) -> poll to completion
 *
 * The run runs async server-side; this tool blocks (polling) only up to
 * `maxWaitSeconds`. If the research is not finished by then, it returns the
 * run id and current status so the caller can continue with
 * `unsloth-research` (status/events/approve).
 */
export default tool({
  description:
    "Run Unsloth Deep Research end-to-end against the local Unsloth backend (unsloth-cli). Given a research prompt it creates a chat thread + message + research run, waits for the plan, auto-approves it, and polls until the research completes. Returns the final report with citations or the run id/status if time runs out. Use for multi-source web research questions served by the LAN Unsloth server.",
  args: {
    prompt: tool.schema
      .string()
      .min(1)
      .describe("The research question or topic to investigate"),
    instructions: tool.schema
      .string()
      .optional()
      .describe("Optional extra instructions for the research agent (max 32000 chars)"),
    title: tool.schema
      .string()
      .optional()
      .describe("Optional chat thread title"),
    maxSteps: tool.schema
      .number()
      .optional()
      .describe("Max research steps (server default is 12)"),
    maxSources: tool.schema
      .number()
      .optional()
      .describe("Max sources per step (server default is 40)"),
    maxWaitSeconds: tool.schema
      .number()
      .optional()
      .describe("Max seconds to wait/poll for completion before returning current status (default 180, max 600)"),
  },
  async execute(args) {
    const maxWait = Math.max(0, Math.min(args.maxWaitSeconds ?? 180, 600))
    const startedAt = Date.now()
    const deadline = startedAt + maxWait * 1000

    const threadId = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    const createdAt = Date.now()

    // 0. Make sure Deep Research is enabled on the backend
    await ensureDeepResearchEnabled()

    // 1. Create thread
    await unslothRequest("POST", "/api/chat/threads", {
      id: threadId,
      modelType: "base",
      modelId: "Qwen3.8-27B-Q8_0",
      createdAt,
      title: args.title ?? `Deep Research: ${args.prompt.slice(0, 60)}`,
    })

    // 2. Post the user message
    await unslothRequest("PUT", `/api/chat/threads/${threadId}/messages`, {
      messages: [
        {
          id: messageId,
          threadId,
          role: "user",
          content: args.prompt,
          createdAt,
        },
      ],
    })

    // 3. Create the research run
    const budgets: Record<string, number> = {}
    if (args.maxSteps !== undefined) budgets.maxSteps = args.maxSteps
    if (args.maxSources !== undefined) budgets.maxSources = args.maxSources
    const { body: run } = await unslothRequest(
      "POST",
      "/api/chat/research-runs",
      {
        threadId,
        userMessageId: messageId,
        instructions: args.instructions ?? null,
        budgets: Object.keys(budgets).length ? budgets : null,
      },
      60_000,
    )
    const runObj = run as Record<string, unknown>
    const runId = String(runObj.id)

    const eventsLog: string[] = []
    let approved = false

    while (Date.now() < deadline) {
      await sleep(5000)
      const { body: cur } = await unslothRequest(
        "GET",
        `/api/chat/research-runs/${runId}`,
      )
      const curObj = cur as Record<string, unknown>
      const status = String(curObj.status ?? "")

      // Auto-approve the plan when it reaches awaiting_approval
      if (status === "awaiting_approval" && !approved) {
        const hash = curObj.planHash as string
        const rev = Number(curObj.planRevision ?? 0)
        await unslothRequest(
          "POST",
          `/api/chat/research-runs/${runId}/approve`,
          { planRevision: rev, planHash: hash },
        )
        approved = true
        eventsLog.push(`[${secSince(startedAt)}] plan approved (revision ${rev})`)
      }

      if (status === "completed" || status === "failed" || status === "cancelled") {
        return await finalReport(runId, status, eventsLog, threadId, messageId)
      }
    }

    // Time ran out — return the run id and current status so the caller can poll
    const { body: cur2 } = await unslothRequest("GET", `/api/chat/research-runs/${runId}`)
    return [
      `Deep Research started but did not finish within ${maxWait}s`,
      `run_id: ${runId}`,
      `thread_id: ${threadId}`,
      `user_message_id: ${messageId}`,
      `status: ${(cur2 as Record<string, unknown>).status}`,
      "Continue polling with unsloth-research (action=status) or fetch events (action=events).",
    ].join("\n")
  },
})

async function ensureDeepResearchEnabled(): Promise<void> {
  const { body } = await unslothRequest("GET", "/api/chat/settings")
  const settings = (body as { settings?: Record<string, unknown> }).settings ?? {}
  if (settings.deepResearchEnabled === true) return
  await unslothRequest("PUT", "/api/chat/settings", {
    deepResearchEnabled: true,
    toolsEnabled: true,
    webFetchToolsEnabled: true,
  })
  await sleep(500)
}

function secSince(startedAt: number): string {
  return `${Math.round((Date.now() - startedAt) / 1000)}s`
}

async function fetchEvents(runId: string): Promise<string[]> {
  try {
    const { body } = await unslothRequest<unknown>(
      "POST",
      `/api/chat/research-runs/${runId}/events`,
      { offset: 0 },
      30_000,
    )
    if (typeof body !== "string") return [JSON.stringify(body)]
    const events: string[] = []
    const blocks = body.split(/\n\n+/)
    for (const block of blocks) {
      const ev = block.match(/^event:\s*(.+)$/m)?.[1]
      const data = block.match(/^data:\s*(.+)$/m)?.[1]
      if (ev) {
        let line = `event=${ev}`
        if (data) {
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>
            line += ` | ${JSON.stringify(parsed).slice(0, 1500)}`
          } catch {
            line += ` | ${data.slice(0, 1500)}`
          }
        }
        events.push(line)
      }
    }
    return events
  } catch {
    return []
  }
}

async function finalReport(
  runId: string,
  status: string,
  eventsLog: string[],
  threadId: string,
  messageId: string,
): Promise<string> {
  const { body: run } = await unslothRequest("GET", `/api/chat/research-runs/${runId}`)
  const runObj = run as Record<string, unknown>

  const report =
    typeof runObj.report === "string"
      ? (runObj.report as string).slice(0, 20_000)
      : ""
  const steps = Array.isArray(runObj.steps) ? (runObj.steps as Record<string, unknown>[]) : []
  const sources = Array.isArray(runObj.sources) ? (runObj.sources as Record<string, unknown>[]) : []

  const events = await fetchEvents(runId)

  const lines: string[] = [
    `Deep Research ${status}`,
    `run_id: ${runId}`,
    `thread_id: ${threadId}`,
    summarizeRun(runObj),
  ]

  if (report) {
    lines.push("", `--- REPORT ---`, report)
  }
  if (sources.length) {
    lines.push("", `--- SOURCES (${sources.length}) ---`)
    for (const s of sources) {
      lines.push(`- ${s.title} <${s.url}>`)
    }
  }
  if (steps.length) {
    lines.push("", `--- STEPS ---`)
    for (const s of steps) {
      lines.push(
        `${Number(s.position ?? 0) + 1}. [${s.status}] ${s.title}` +
          (s.query ? ` — ${s.query}` : ""),
      )
    }
  }
  if (events.length) {
    lines.push("", `--- EVENTS (${events.length}) ---`)
    lines.push(...events.slice(0, 40))
  }
  if (eventsLog.length) {
    lines.push("", `--- LOCAL EVENTS ---`)
    lines.push(...eventsLog)
  }

  return lines.join("\n")
}