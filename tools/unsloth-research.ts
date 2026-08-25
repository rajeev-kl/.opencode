import { tool } from "@opencode-ai/plugin"
import { unslothRequest, sleep, summarizeRun } from "../lib/unsloth"

/**
 * Low-level control tool for Unsloth Deep Research runs.
 * Use this for manual orchestration / continued polling of a run, e.g. after
 * `unsloth-deep-research` timed out. Actions:
 *
 *   - start:    create thread + user message + research run (returns run_id)
 *   - status:   GET one run (run_id) or list active runs (thread_id)
 *   - events:   POST to the run's event stream (offset param)
 *   - approve:  approve the plan (revision/hash fetched from the run if omitted)
 *   - cancel:   cancel a run
 */
export default tool({
  description:
    "Control Unsloth Deep Research runs on the local Unsloth backend. Actions: start (create thread+message+run, returns run_id), status (run state + plan), events (run event log), approve (approve the research plan), cancel. Use this to manually drive or keep polling research started by unsloth-deep-research.",
  args: {
    action: tool.schema.string().describe("start | status | events | approve | cancel"),
    prompt: tool.schema
      .string()
      .optional()
      .describe("Research question (required for action=start)"),
    run_id: tool.schema.string().optional().describe("Research run id (required for status/events/approve/cancel)"),
    thread_id: tool.schema.string().optional().describe("Thread id (required for action=status to list active runs)"),
    user_message_id: tool.schema
      .string()
      .optional()
      .describe("Id of the user message to trigger research (start only)"),
    instructions: tool.schema.string().optional().describe("Extra instructions for the research agent (start only)"),
    maxSteps: tool.schema.number().optional().describe("Max research steps (start only)"),
    maxSources: tool.schema.number().optional().describe("Max sources per step (start only)"),
    offset: tool.schema.number().optional().describe("Event offset (events only, default 0)"),
    plan_revision: tool.schema.number().optional().describe("Plan revision to approve (defaults to run value)"),
    plan_hash: tool.schema.string().optional().describe("Plan hash to approve (defaults to run value)"),
  },
  async execute(args, context) {
    switch (args.action) {
      case "start": {
        if (!args.prompt) throw new Error("prompt is required for action=start")
        await ensureDeepResearchEnabled()
        const threadId = args.thread_id ?? crypto.randomUUID()
        const messageId = args.user_message_id ?? crypto.randomUUID()
        const createdAt = Date.now()
        if (!args.thread_id) {
          await unslothRequest("POST", "/api/chat/threads", {
            id: threadId,
            modelType: "base",
            modelId: "Qwen3.8-27B-Q8_0",
            createdAt,
            title: `Deep Research: ${args.prompt.slice(0, 60)}`,
          })
        }
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
        return [
          `Research started`,
          `run_id: ${runObj.id}`,
          `thread_id: ${threadId}`,
          `user_message_id: ${messageId}`,
          summarizeRun(runObj),
          "Poll with unsloth-research (action=status), approve the plan when ready, then fetch events or the final status.",
        ].join("\n")
      }

      case "status": {
        if (!args.run_id && !args.thread_id) {
          throw new Error("run_id (single run) or thread_id (active runs) required for action=status")
        }
        if (args.run_id) {
          const { body } = await unslothRequest("GET", `/api/chat/research-runs/${args.run_id}`)
          return formatStatus(body as Record<string, unknown>)
        }
        const q = new URLSearchParams({ threadId: args.thread_id! })
        const { body } = await unslothRequest("GET", `/api/chat/research-runs/active?${q}`)
        const listObj = body as { runs?: unknown[] }
        if (!Array.isArray(listObj.runs) || listObj.runs.length === 0) {
          return `No active research runs for thread ${args.thread_id}`
        }
        return (listObj.runs as Record<string, unknown>[])
          .map((r) => formatStatus(r))
          .join("\n\n")
      }

      case "events": {
        if (!args.run_id) throw new Error("run_id required for action=events")
        const { body } = await unslothRequest<unknown>(
          "POST",
          `/api/chat/research-runs/${args.run_id}/events`,
          { offset: args.offset ?? 0 },
        )
        // The events endpoint returns SSE text (id:/event:/data: lines), not JSON.
        if (typeof body === "string") return body.slice(0, 30_000)
        return JSON.stringify(body, null, 2).slice(0, 30_000)
      }

      case "approve": {
        if (!args.run_id) throw new Error("run_id required for action=approve")
        const { body: run } = await unslothRequest("GET", `/api/chat/research-runs/${args.run_id}`)
        const runObj = run as Record<string, unknown>
        const revision = args.plan_revision ?? Number(runObj.planRevision ?? 0)
        const hash = args.plan_hash ?? (runObj.planHash as string)
        if (!hash) {
          return `Run ${args.run_id} has no plan to approve yet (status=${runObj.status})`
        }
        await unslothRequest("POST", `/api/chat/research-runs/${args.run_id}/approve`, {
          planRevision: revision,
          planHash: hash,
        })
        return `Plan approved for run ${args.run_id} (revision ${revision})`
      }

      case "cancel": {
        if (!args.run_id) throw new Error("run_id required for action=cancel")
        await unslothRequest("POST", `/api/chat/research-runs/${args.run_id}/cancel`)
        return `Cancelled run ${args.run_id}`
      }

      default:
        throw new Error(
          `Unknown action '${args.action}' — expected start | status | events | approve | cancel`,
        )
    }
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

function formatStatus(run: Record<string, unknown>): string {
  const lines = [summarizeRun(run)]
  if (run.status === "awaiting_approval" && run.plan) {
    const plan = run.plan as { title?: string; steps?: unknown[] }
    lines.push(`Plan title: ${plan.title ?? "(untitled)"}`)
    if (Array.isArray(plan.steps)) {
      for (let i = 0; i < plan.steps.length; i++) {
        const s = plan.steps[i] as Record<string, unknown>
        lines.push(`  ${i + 1}. ${s.title ?? ""} — ${s.query ?? ""}`.trim())
      }
    }
    lines.push(
      `Approve with: unsloth-research action=approve run_id=${run.id} (auto-uses revision ${run.planRevision} + hash)`,
    )
  }
  return lines.join("\n")
}