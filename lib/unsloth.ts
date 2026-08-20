/**
 * Unsloth backend API helper shared by the unsloth-deep-research and
 * unsloth-research custom tools.
 *
 * Talks to the Unsloth UI Backend (unsloth-cli) on the LAN host. The
 * OpenAI-compatible /v1/* surface is used by the qwen model provider; the
 * /api/* surface here exposes the agentic stack (Deep Research runs, chat
 * threads, tool-confirm, sandbox, MCP hosting).
 *
 * Auth: Bearer token from env API_KEY (same key opencode.json uses), or
 * UNSLOTH_API_KEY override.
 */
export const UNSLOTH_BASE_URL =
  process.env.UNSLOTH_BASE_URL ?? "http://proart-px13.local:1234"

export function unslothApiKey(): string {
  const key = process.env.UNSLOTH_API_KEY ?? process.env.API_KEY
  if (!key) throw new Error("UNSLOTH_API_KEY / API_KEY env var is not set")
  return key
}

export type UnslothError = {
  kind: "http" | "network"
  status?: number
  detail?: unknown
  message: string
}

export async function unslothRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 45_000,
): Promise<{ status: number; body: T }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(UNSLOTH_BASE_URL + path, {
      method,
      headers: {
        Authorization: `Bearer ${unslothApiKey()}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (e) {
    throw { kind: "network", message: String(e) } satisfies UnslothError
  } finally {
    clearTimeout(timer)
  }

  let json: unknown = {}
  const text = await res.text()
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
  }

  if (!res.ok) {
    throw {
      kind: "http",
      status: res.status,
      detail: json,
      message: `Unsloth API ${method} ${path} -> ${res.status}`,
    } satisfies UnslothError
  }

  return { status: res.status, body: json as T }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Summarize a research run object into a compact readable status line. */
export function summarizeRun(run: Record<string, unknown>): string {
  const parts = [
    `id=${run.id}`,
    `status=${run.status}`,
    `revision=${run.planRevision ?? 0}`,
  ]
  if (run.planHash) parts.push("plan=ready")
  if (run.plan && run.plan.title) {
    const stepCount = Array.isArray(run.plan.steps) ? run.plan.steps.length : 0
    parts.push(`planTitle=${JSON.stringify(run.plan.title)}`, `steps=${stepCount}`)
  }
  if (run.error) parts.push(`error=${JSON.stringify(run.error).slice(0, 200)}`)
  return parts.join(" | ")
}