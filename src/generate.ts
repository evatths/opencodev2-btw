import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SessionGenerate } from "@opencode/plugin/promise/session"
import type { Question } from "./rpc.ts"

export type AskProfile = {
  system?: string
  mode: string
  hidden: boolean
  permissions: readonly { action: string; resource: string; effect: string }[]
}

export const DEFAULT_AGENT = "ask"

/**
 * The configured agent id: a non-blank string `agent` option, else "ask".
 * Non-string or blank options fall back to the default.
 */
export function normalizeAgentOption(options: { agent?: unknown }): string {
  return typeof options.agent === "string" && options.agent.trim() ? options.agent.trim() : DEFAULT_AGENT
}

/**
 * Load the bundled Ask persona. Resolved from import.meta.url — the file
 * sits next to this module, which holds for source checkouts and installed
 * packages alike. A leading YAML frontmatter block (agent-definition
 * style) is tolerated and stripped.
 */
export function loadBuiltinPrompt(url: string | URL = import.meta.url): string {
  const text = readFileSync(join(dirname(fileURLToPath(url)), "ask.md"), "utf8")
  const stripped = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
  if (!stripped.trim()) throw new Error("The bundled Ask persona (src/ask.md) is empty.")
  return stripped.trim()
}

/** Until V2 accepts an agent override, support the canonical blanket-deny profile. */
export function validateAsk(agent: AskProfile): string {
  if (!agent.system?.trim() || agent.hidden || !["primary", "all"].includes(agent.mode)) {
    throw new Error("Ask must be a visible primary agent with a system prompt. Check your ask agent configuration; the BTW fallback only applies when no agent is configured.")
  }
  const last = agent.permissions.at(-1)
  if (last?.action !== "*" || last.resource !== "*" || last.effect !== "deny") {
    throw new Error("Ask must end with a blanket no-tools permission rule. The BTW adapter does not support partial tool policies.")
  }
  return agent.system
}

/**
 * Bedrock's Converse API rejects a request whose history still carries
 * tool-call/tool-result content once tools are empty: "The toolConfig field
 * must be defined when using toolUse and toolResult content blocks." Ask
 * always sends zero tools (validateAsk enforces the blanket deny), so
 * flatten any inherited tool activity into plain text instead of stripping
 * it — the model still sees what ran, just not as a block the provider
 * expects a matching toolConfig for. This reproduces without this plugin
 * too (any zero-tool agent switch on a Bedrock session with tool history);
 * the host does not sanitize history, so this belongs here.
 */
export function flattenToolHistory(messages: SessionGenerate["messages"]): SessionGenerate["messages"] {
  return messages.map((message) => {
    const content = (message.content as any[]).map((part: any) => {
      if (part.type === "tool-call") return { type: "text", text: `[ran ${part.name}: ${describe(part.input)}]` }
      if (part.type === "tool-result") return { type: "text", text: `[${part.name} result: ${describe(resultValue(part.result))}]` }
      return part
    })
    // A lone tool-result message carries role "tool"; once it's plain text
    // it reads better, and travels safer across providers, as a user turn.
    return message.role === "tool" ? { ...message, role: "user", content } : { ...message, content }
  }) as SessionGenerate["messages"]
}

/**
 * The primary agent loop's `session.context` hook: Ask turns on a session whose
 * inherited history still carries tool-call/tool-result content hit the same
 * Bedrock toolConfig rejection as `/btw` (see flattenToolHistory). This covers
 * an Expand-to-Fork's first message and any session switched to Ask via the
 * ordinary picker. Other agents are left untouched.
 */
export function sanitizeAskContext(event: { agent: string; tools: Record<string, unknown>; messages: SessionGenerate["messages"] }, agentID: string = DEFAULT_AGENT): void {
  if (String(event.agent) !== agentID) return
  if (Object.keys(event.tools).length > 0) return
  event.messages = flattenToolHistory(event.messages)
}

function resultValue(result: unknown): unknown {
  return result && typeof result === "object" && "value" in result ? (result as { value: unknown }).value : result
}

function describe(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value)
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text
}

type Pending = { input: Question; system: string; model: string; applied: boolean }

export interface GeneratorPorts {
  location: { directory: string; workspaceID?: string }
  /** Configured BYO agent id ("ask" by default). */
  agentID: string
  /** Bundled persona used when the configured agent is missing or unreachable. */
  builtinPrompt: string
  session: {
    get(input: { sessionID: string }, options: { signal: AbortSignal }): Promise<{ location: { directory: string; workspaceID?: string } }>
    generate(input: { sessionID: string; prompt: string }, options: { signal: AbortSignal }): Promise<{ text: string }>
  }
  agent: {
    get(input: { agentID: string; location: { directory: string; workspaceID?: string } }, options: { signal: AbortSignal }): Promise<{ data: AskProfile }>
  }
}

export function createGenerator(ctx: GeneratorPorts) {
  const pending = new Map<string, Pending>()
  const active = new Set<AbortController>()
  const byID = new Map<string, AbortController>()
  // A cancel HTTP request can overtake ask on another connection. Short-lived
  // tombstones cover that race; their count and lifetime are both bounded.
  const cancelled = new Map<string, number>()
  const prune = () => {
    for (const [key, time] of cancelled) if (time < Date.now() - 60_000) cancelled.delete(key)
    while (cancelled.size > 256) cancelled.delete(cancelled.keys().next().value!)
  }
  return {
    cancel(input: { sessionID: string; requestID: string }) {
      const key = `${input.sessionID}:${input.requestID}`
      const request = byID.get(key)
      if (request) request.abort()
      else cancelled.set(key, Date.now())
      prune()
      return { cancelled: true }
    },
    hook(event: SessionGenerate) {
      const last = event.messages.at(-1)
      if (last?.role !== "user" || last.content.length !== 1 || last.content[0].type !== "text") return
      const request = pending.get(last.content[0].text)
      if (!request || request.input.sessionID !== event.sessionID) return
      // v2.0.3 baseTranscript puts the agent/harness prompt first, followed by
      // initial project instructions. Instruction updates live in messages.
      event.system.splice(0, 1, { type: "text", text: request.system })
      event.tools = {}
      event.messages = flattenToolHistory(event.messages)
      event.messages.pop()
      if (request.input.exchanges.length) {
        event.messages.push({ role: "system", content: [{ type: "text", text: "Prior BTW exchanges follow. The parent context above may have advanced since these answers." }] })
      }
      for (const exchange of request.input.exchanges) {
        event.messages.push({ role: "user", content: [{ type: "text", text: exchange.question }] })
        event.messages.push({ role: "assistant", content: [{ type: "text", text: exchange.answer }] })
      }
      event.messages.push({ role: "user", content: [{ type: "text", text: request.input.question }] })
      request.model = `${event.model.providerID}/${event.model.id}${event.model.variant ? `#${event.model.variant}` : ""}`
      request.applied = true
    },
    async ask(input: Question, signal: AbortSignal) {
      prune()
      const key = `${input.sessionID}:${input.requestID ?? crypto.randomUUID()}`
      if (cancelled.delete(key)) throw new DOMException("BTW request cancelled", "AbortError")
      if (byID.has(key)) throw new Error("This BTW request is already running.")
      const controller = new AbortController()
      byID.set(key, controller)
      active.add(controller)
      const timeout = setTimeout(() => controller.abort(new Error("Ask timed out after two minutes. Retry explicitly.")), 120_000)
      const abort = () => controller.abort(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      const options = { signal: controller.signal }
      const marker = `<btw-request:${crypto.randomUUID()}>`
      try {
        controller.signal.throwIfAborted()
        const parent = await ctx.session.get({ sessionID: input.sessionID }, options)
        // Hooks belong to the plugin's location. Reject a stale/moved RPC route
        // instead of generating a marker under another location's hook instance.
        if (parent.location.directory !== ctx.location.directory || parent.location.workspaceID !== ctx.location.workspaceID) {
          throw new Error("The parent moved. Reopen BTW in its current location and retry.")
        }
        // BYO precedence, resolved per ask: an existing configured agent
        // supplies and validates its own prompt; only a missing or
        // unreachable agent falls back to the bundled persona. Per-ask (not
        // setup-time) resolution avoids the boot race where the agent list is
        // not populated yet when plugin setup runs.
        let profile: AskProfile | undefined
        try {
          profile = (await ctx.agent.get({ agentID: ctx.agentID, location: parent.location }, options)).data
        } catch {
          profile = undefined
        }
        const system = profile ? validateAsk(profile) : ctx.builtinPrompt
        const request: Pending = { input, system, model: "", applied: false }
        pending.set(marker, request)
        const answer = await ctx.session.generate({ sessionID: input.sessionID, prompt: marker }, options)
        controller.signal.throwIfAborted()
        if (!request.applied) throw new Error("The BTW generation hook did not run. Reload the plugin before retrying.")
        if (!answer.text.trim()) throw new Error("Ask returned no text. Your question is saved; retry explicitly.")
        if (answer.text.length > 128_000) throw new Error("Ask's response exceeded the aside limit. Please ask a narrower question.")
        return { text: answer.text, model: request.model }
      } finally {
        pending.delete(marker)
        byID.delete(key)
        active.delete(controller)
        clearTimeout(timeout)
        signal.removeEventListener("abort", abort)
      }
    },
    dispose() { for (const request of active) request.abort(); pending.clear(); cancelled.clear() },
  }
}
