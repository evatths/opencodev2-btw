/**
 * Regression tests for the BTW (by-the-way) aside plugin.
 *
 * Run from the repo root:
 *   npm test
 *   node --experimental-strip-types --test tests/btw.test.mts
 *
 * Exercises the REAL aside.ts (client-lifetime aside state machine) and
 * generate.ts (marker-routed generation hook) with plain-object mock ports —
 * no live network, no service, no model calls.
 *
 * Areas covered:
 *   - validateAsk: canonical no-tools profile, last-rule blanket deny
 *   - ask resolution: bring-your-own agent precedence, bundled fallback,
 *     option override
 *   - marker ownership: only owned pending markers applied, overlapping
 *     generates isolated, cross-session/stale markers rejected
 *   - hook composition: latest context, prior role messages, tool stripping
 *   - aside: cancel/stale answers, saved drafts, retries, expand single-flight
 *     + operation-ID reuse, reset guard rails
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createAside } from "../src/aside.ts"
import { createGenerator, loadBuiltinPrompt, normalizeAgentOption, sanitizeAskContext, validateAsk, type AskProfile } from "../src/generate.ts"
import { MAX_EXCHANGES, MAX_QUESTION } from "../src/rpc.ts"

/** Flush pending microtasks so immediately-resolving mock chains settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// Aside mock ports
// ---------------------------------------------------------------------------

function mockPorts() {
  const asks: { input: any; signal: AbortSignal; d: ReturnType<typeof deferred> }[] = []
  const expands: { input: any; d: ReturnType<typeof deferred> }[] = []
  const ports = {
    ask(input: any, signal: AbortSignal) {
      const d = deferred()
      asks.push({ input, signal, d })
      return d.promise as Promise<{ text: string; model: string }>
    },
    expand(input: any) {
      const d = deferred()
      expands.push({ input, d })
      return d.promise as Promise<{ sessionID: string }>
    },
  }
  return { ports, asks, expands }
}

// ---------------------------------------------------------------------------
// Generator mock context
// ---------------------------------------------------------------------------

/** The canonical no-tools ask profile a bring-your-own agent normalizes to. */
function canonicalProfile(over: Partial<AskProfile> = {}): AskProfile {
  return {
    system: "Answer the user's question using the context already available.",
    mode: "primary",
    hidden: false,
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
    ...over,
  }
}

function mockCtx({ directory = "/repo", workspace = "ws-1", agentID = "ask", agentAvailable = true, profile = {} }: { directory?: string; workspace?: string; agentID?: string; agentAvailable?: boolean; profile?: Partial<AskProfile> } = {}) {
  const sessionGets: { args: any; options: any }[] = []
  const agentGets: { args: any; options: any }[] = []
  const generates: { args: any; options: any; d: ReturnType<typeof deferred> }[] = []
  const ctx = {
    location: { directory, workspaceID: workspace },
    agentID,
    builtinPrompt: BUILTIN,
    session: {
      get(args: any, options: any) {
        sessionGets.push({ args, options })
        return Promise.resolve({ location: { directory, workspaceID: workspace } })
      },
      generate(args: any, options: any) {
        const d = deferred()
        generates.push({ args, options, d })
        // Mirror the real API: aborting the signal rejects the pending generate.
        options.signal.addEventListener("abort", () => d.reject(options.signal.reason), { once: true })
        return d.promise as Promise<{ text: string }>
      },
    },
    agent: {
      get(args: any, options: any) {
        agentGets.push({ args, options })
        return agentAvailable ? Promise.resolve({ data: canonicalProfile(profile) }) : Promise.reject(new Error("Agent not found"))
      },
    },
  }
  return { ctx, sessionGets, agentGets, generates }
}

/** Synthetic SessionGenerate hook event shaped like @opencode/plugin 2.0.3. */
function generateEvent(
  sessionID: string,
  lastText: string,
  { prior = [], variant, model }: {
    /** Mock messages, including synthetic tool-call/tool-result parts. */
    prior?: any[]
    variant?: string
    model?: { providerID: string; id: string; variant?: string }
  } = {},
) {
  return {
    sessionID,
    agent: "ask",
    model: model ?? { providerID: "acme", id: "m1", ...(variant ? { variant } : {}) },
    system: [
      { type: "text", text: "harness prompt" },
      { type: "text", text: "initial project instructions" },
    ],
    messages: [...prior, { role: "user", content: [{ type: "text", text: lastText }] }],
    tools: { bash: { description: "run a command", input: { type: "object" } } },
  } as any
}

/** Start a generator ask and drive its marker through the hook. */
async function askThroughHook(
  gen: ReturnType<typeof createGenerator>,
  state: ReturnType<typeof mockCtx>,
  input: any,
  eventOverrides: Parameters<typeof generateEvent>[2] = {},
) {
  const promise = gen.ask(input, new AbortController().signal)
  await settle()
  const call = state.generates.at(-1)!
  const event = generateEvent(input.sessionID, call.args.prompt, eventOverrides)
  gen.hook(event)
  call.d.resolve({ text: "hooked answer" })
  return { promise, event, call }
}

// ---------------------------------------------------------------------------
// validateAsk — canonical no-tools validation (last blanket deny)
// ---------------------------------------------------------------------------

test("validateAsk accepts a blanket-deny primary profile and returns its system prompt", () => {
  const profile = canonicalProfile()
  assert.equal(validateAsk(profile), profile.system)
})

test("validateAsk rejects a hidden agent", () => {
  assert.throws(() => validateAsk(canonicalProfile({ hidden: true })), /Ask must/)
})

test("validateAsk rejects a missing or blank system prompt", () => {
  assert.throws(() => validateAsk(canonicalProfile({ system: undefined })), /Ask must/)
  assert.throws(() => validateAsk(canonicalProfile({ system: "   " })), /Ask must/)
})

test("validateAsk rejects a non-primary agent mode", () => {
  assert.throws(() => validateAsk(canonicalProfile({ mode: "subordinate" })), /Ask must/)
})

test("validateAsk rejects missing permissions", () => {
  assert.throws(() => validateAsk(canonicalProfile({ permissions: [] })), /blanket no-tools/)
})

test("validateAsk rejects when the last rule is not the blanket deny", () => {
  const specific = canonicalProfile({
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "files", effect: "allow" },
    ],
  })
  assert.throws(() => validateAsk(specific), /blanket no-tools/)

  const scopedDeny = canonicalProfile({
    permissions: [{ action: "bash", resource: "*", effect: "deny" }],
  })
  assert.throws(() => validateAsk(scopedDeny), /blanket no-tools/)

  const allow = canonicalProfile({
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  })
  assert.throws(() => validateAsk(allow), /blanket no-tools/)
})

// ---------------------------------------------------------------------------
// resolveAskStrategy — bring your own agent vs the bundled persona
// ---------------------------------------------------------------------------

const BUILTIN = "Answer the user's question using the context already available."

test("normalizeAgentOption defaults to ask and trims a real override", () => {
  assert.equal(normalizeAgentOption({}), "ask")
  assert.equal(normalizeAgentOption({ agent: "custom-ask" }), "custom-ask")
  assert.equal(normalizeAgentOption({ agent: "  custom-ask  " }), "custom-ask")
  for (const agent of ["   ", 42, null, true]) {
    assert.equal(normalizeAgentOption({ agent }), "ask")
  }
})

test("loadBuiltinPrompt reads the bundled src/ask.md persona", () => {
  const prompt = loadBuiltinPrompt()
  assert.match(prompt, /using the context already available/)
  assert.match(prompt, /concisely and stop/)
  assert.ok(!prompt.startsWith("---"), "frontmatter, if any, must be stripped")
  assert.ok(!/\bloadout\b|\bEvatt\b/i.test(prompt), "the bundled persona must be author-agnostic")
})

test("a missing configured agent falls back to the bundled persona per ask", async () => {
  const state = mockCtx({ agentAvailable: false })
  const gen = createGenerator(state.ctx as any)
  const { event, promise } = await askThroughHook(gen, state, {
    sessionID: "ses_parent", question: "what did you decide?", exchanges: [],
  })
  assert.equal(state.agentGets.length, 1, "the configured agent is fetched; its absence triggers the fallback")
  assert.deepEqual(await promise, { text: "hooked answer", model: "acme/m1" })
  // Same hook contract as the agent strategy: first system part replaced,
  // later instructions kept, tools zeroed, question appended last.
  assert.equal(event.system.length, 2)
  assert.equal(event.system[0].text, BUILTIN)
  assert.equal(event.system[1].text, "initial project instructions")
  assert.deepEqual(event.tools, {})
  assert.equal(event.messages.at(-1)!.content[0].text, "what did you decide?")
})

test("the bundled persona still flattens inherited tool history", async () => {
  const state = mockCtx({ agentAvailable: false })
  const gen = createGenerator(state.ctx as any)
  const prior = [
    { role: "tool", content: [
      { type: "tool-result", id: "call_1", name: "bash", result: { type: "text", value: "/repo" } },
    ] },
  ]
  const { event } = await askThroughHook(gen, state, {
    sessionID: "ses_parent", question: "and?", exchanges: [],
  }, { prior })
  assert.ok(!JSON.stringify(event.messages).includes('"tool-result"'))
  assert.equal((event.messages[0] as any).role, "user")
})

test("the configured agent id is fetched and its validated prompt used", async () => {
  const state = mockCtx({ agentID: "my-ask" })
  const gen = createGenerator(state.ctx as any)
  const { event } = await askThroughHook(gen, state, {
    sessionID: "ses_parent", question: "q?", exchanges: [],
  })
  assert.equal(state.agentGets.length, 1)
  assert.equal(state.agentGets[0].args.agentID, "my-ask")
  assert.equal(event.system[0].text, canonicalProfile().system)
})

test("a present but nonconforming agent errors instead of silently degrading", async () => {
  const state = mockCtx({ profile: { permissions: [{ action: "bash", resource: "*", effect: "allow" }] } })
  const gen = createGenerator(state.ctx as any)
  const promise = gen.ask({ sessionID: "ses_parent", question: "q?", exchanges: [] }, new AbortController().signal)
  await assert.rejects(promise, /blanket no-tools/)
})

test("context hook honors the configured agent id", () => {
  const event = contextEvent("custom-ask", {}, toolHistory)
  sanitizeAskContext(event, "custom-ask")
  assert.ok(!JSON.stringify(event.messages).includes('"tool-call"'), "the configured agent's turns are flattened")
  const other = contextEvent("ask", {}, toolHistory)
  sanitizeAskContext(other, "custom-ask")
  assert.ok(JSON.stringify(other.messages).includes('"tool-call"'), "the default ask id is untouched under a custom id")
})

// ---------------------------------------------------------------------------
// Generator hook — marker ownership
// ---------------------------------------------------------------------------

test("hook ignores generates that are not a single-text user message", () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)

  for (const kind of ["assistant-last", "multi-part", "non-marker"]) {
    const event = generateEvent("ses_parent", "not-a-marker")
    if (kind === "assistant-last") {
      event.messages = [{ role: "assistant", content: [{ type: "text", text: "hi" }] }]
    } else if (kind === "multi-part") {
      event.messages = [
        { role: "user", content: [{ type: "text", text: "not-a-marker" }, { type: "text", text: "extra" }] },
      ]
    }
    const snapshot = structuredClone(event)
    gen.hook(event)
    assert.deepEqual(event.messages, snapshot.messages)
    assert.notDeepEqual(event.tools, {})
    assert.equal(event.system[0].text, "harness prompt")
  }
})

test("hook applies only the owned pending marker; overlapping asks stay isolated", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const inputA = { sessionID: "ses_parent", question: "question A?", exchanges: [] }
  const inputB = { sessionID: "ses_parent", question: "question B?", exchanges: [] }

  const promiseA = gen.ask(inputA, new AbortController().signal)
  const promiseB = gen.ask(inputB, new AbortController().signal)
  await settle()
  assert.equal(state.generates.length, 2)
  assert.notEqual(state.generates[0].args.prompt, state.generates[1].args.prompt)

  // Deliver B's generate first: B's event must carry B's question, never A's.
  const eventB = generateEvent("ses_parent", state.generates[1].args.prompt)
  gen.hook(eventB)
  assert.equal(eventB.messages.at(-1)!.content[0].text, "question B?")
  assert.equal(eventB.messages.at(-1)!.role, "user")
  assert.ok(!JSON.stringify(eventB.messages).includes("question A?"))
  assert.deepEqual(eventB.tools, {})

  // A is still pending and applies independently with its own event.
  const eventA = generateEvent("ses_parent", state.generates[0].args.prompt, {
    model: { providerID: "acme", id: "m2", variant: "high" },
  })
  gen.hook(eventA)
  assert.equal(eventA.messages.at(-1)!.content[0].text, "question A?")
  assert.deepEqual(eventA.tools, {})

  state.generates[0].d.resolve({ text: "answer A" })
  state.generates[1].d.resolve({ text: "answer B" })
  const answerA = await promiseA
  const answerB = await promiseB
  assert.deepEqual(answerA, { text: "answer A", model: "acme/m2#high" })
  assert.deepEqual(answerB, { text: "answer B", model: "acme/m1" })
})

test("hook ignores a marker from another session (parent isolation)", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const input = { sessionID: "ses_parent", question: "only mine?", exchanges: [] }
  const promise = gen.ask(input, new AbortController().signal)
  await settle()
  const call = state.generates[0]

  // Same marker text, but a different session: the pending request is not ours.
  const foreign = generateEvent("ses_elsewhere", call.args.prompt)
  gen.hook(foreign)
  assert.equal(foreign.messages.length, 1)
  assert.deepEqual(foreign.tools, { bash: { description: "run a command", input: { type: "object" } } })

  call.d.resolve({ text: "should never surface" })
  await assert.rejects(promise, /did not run/)
})

test("stale marker after completion is ignored", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const input = { sessionID: "ses_parent", question: "done already?", exchanges: [] }
  const first = await askThroughHook(gen, state, input)
  await first.promise

  const replay = generateEvent("ses_parent", first.call.args.prompt)
  gen.hook(replay)
  assert.equal(replay.messages.length, 1)
  assert.notDeepEqual(replay.tools, {})
})

test("hook replaces only the first system part and keeps later instructions", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const { event } = await askThroughHook(gen, state, {
    sessionID: "ses_parent", question: "q?", exchanges: [],
  })
  assert.equal(event.system.length, 2)
  assert.equal(event.system[0].text, canonicalProfile().system)
  assert.equal(event.system[1].text, "initial project instructions")
})

// ---------------------------------------------------------------------------
// Generator hook — latest context + prior role messages preservation
// ---------------------------------------------------------------------------

test("hook pops the marker, replays exchanges as roles, appends the question last", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const prior = [
    { role: "user", content: [{ type: "text", text: "older user context" }] },
    { role: "assistant", content: [{ type: "text", text: "older assistant reply" }] },
  ]
  const exchanges = [
    { question: "q1?", answer: "a1!", time: 1 },
    { question: "q2?", answer: "a2!", time: 2 },
  ]
  const { event } = await askThroughHook(gen, state, {
    sessionID: "ses_parent", question: "final question?", exchanges,
  }, { prior })

  const texts = event.messages.map((m: any) => m.content[0].text)
  assert.deepEqual(texts, [
    "older user context",
    "older assistant reply",
    "Prior BTW exchanges follow. The parent context above may have advanced since these answers.",
    "q1?", "a1!", "q2?", "a2!",
    "final question?",
  ])
  assert.equal(event.messages.at(-1)!.role, "user")
  // Prior messages preserved untouched (roles intact).
  assert.equal(event.messages[0].role, "user")
  assert.equal(event.messages[1].role, "assistant")
  // Marker message was popped, tools stripped.
  assert.ok(!JSON.stringify(event.messages).includes("<btw-request:"))
  assert.deepEqual(event.tools, {})
})

test("hook adds no separator message when there are no prior exchanges", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const prior = [{ role: "assistant", content: [{ type: "text", text: "parent reply" }] }]
  const { event } = await askThroughHook(gen, state, {
    sessionID: "ses_parent", question: "fresh?", exchanges: [],
  }, { prior })
  assert.deepEqual(event.messages.map((m: any) => m.content[0].text), ["parent reply", "fresh?"])
})

// ---------------------------------------------------------------------------
// Generator hook — flattening inherited tool-call/tool-result content
//
// Bedrock's Converse API rejects a request whose history still carries
// toolUse/toolResult blocks once tools are empty ("The toolConfig field must
// be defined..."). Ask always sends zero tools, so the hook must flatten any
// inherited tool activity into text before generating. Reproduced live
// against a real Bedrock-backed model; see side-questions.md.
// ---------------------------------------------------------------------------

test("hook flattens an inherited tool-call so no tool-call block reaches the provider", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const prior = [
    { role: "assistant", content: [
      { type: "text", text: "let me check" },
      { type: "tool-call", id: "call_1", name: "bash", input: { command: "pwd" } },
    ] },
  ]
  const { event } = await askThroughHook(gen, state, {
    sessionID: "ses_parent", question: "what did that show?", exchanges: [],
  }, { prior })

  const first = event.messages[0] as any
  assert.equal(first.role, "assistant")
  assert.deepEqual(first.content.map((p: any) => p.type), ["text", "text"])
  assert.equal(first.content[0].text, "let me check")
  assert.equal(first.content[1].text, '[ran bash: {"command":"pwd"}]')
  assert.ok(!JSON.stringify(event.messages).includes('"tool-call"'))
})

test("hook flattens an inherited tool-result message and turns its role into user", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const prior = [
    { role: "tool", content: [
      { type: "tool-result", id: "call_1", name: "bash", result: { type: "text", value: "/Users/evatt" } },
    ] },
  ]
  const { event } = await askThroughHook(gen, state, {
    sessionID: "ses_parent", question: "what did that show?", exchanges: [],
  }, { prior })

  const first = event.messages[0] as any
  assert.equal(first.role, "user")
  assert.deepEqual(first.content, [{ type: "text", text: "[bash result: /Users/evatt]" }])
  assert.ok(!JSON.stringify(event.messages).includes('"tool-result"'))
})

test("hook truncates an oversized flattened tool result", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const huge = "x".repeat(3000)
  const prior = [
    { role: "tool", content: [
      { type: "tool-result", id: "call_1", name: "grep", result: { type: "text", value: huge } },
    ] },
  ]
  const { event } = await askThroughHook(gen, state, {
    sessionID: "ses_parent", question: "and?", exchanges: [],
  }, { prior })
  const text = (event.messages[0] as any).content[0].text as string
  assert.ok(text.length < 2100)
  assert.ok(text.endsWith("…]"))
})

test("hook leaves plain-text history untouched by the flattening pass", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const prior = [{ role: "user", content: [{ type: "text", text: "no tools here" }] }]
  const { event } = await askThroughHook(gen, state, {
    sessionID: "ses_parent", question: "q?", exchanges: [],
  }, { prior })
  assert.deepEqual(event.messages[0], { role: "user", content: [{ type: "text", text: "no tools here" }] })
})

// ---------------------------------------------------------------------------
// Primary-loop context hook (sanitizeAskContext) — Expand-to-Fork's first
// message and picker-selected Ask turns go through the ordinary agent loop,
// not session.generate. Same Bedrock toolConfig contract as above.
// ---------------------------------------------------------------------------

function contextEvent(agent: string, tools: Record<string, unknown>, prior: any[]) {
  return { agent, tools, messages: [...prior, { role: "user", content: [{ type: "text", text: "next?" }] }] }
}

const toolHistory = [
  { role: "assistant", content: [
    { type: "tool-call", id: "call_1", name: "bash", input: { command: "pwd" } },
  ] },
  { role: "tool", content: [
    { type: "tool-result", id: "call_1", name: "bash", result: { type: "text", value: "/home" } },
  ] },
]

test("context hook flattens tool history on an ask turn with zero tools", () => {
  const event = contextEvent("ask", {}, toolHistory)
  sanitizeAskContext(event)
  const json = JSON.stringify(event.messages)
  assert.ok(!json.includes('"tool-call"'))
  assert.ok(!json.includes('"tool-result"'))
  assert.equal((event.messages[0] as any).content[0].text, '[ran bash: {"command":"pwd"}]')
  assert.equal((event.messages[1] as any).content[0].text, "[bash result: /home]")
  assert.equal((event.messages[1] as any).role, "user")
  // The current question rides along untouched.
  assert.equal((event.messages.at(-1) as any).content[0].text, "next?")
})

test("context hook leaves other agents' turns untouched", () => {
  const event = contextEvent("build", {}, toolHistory)
  sanitizeAskContext(event)
  assert.ok(JSON.stringify(event.messages).includes('"tool-call"'))
})

test("context hook leaves ask turns untouched when tools are present", () => {
  const event = contextEvent("ask", { bash: { description: "run", input: {} } }, toolHistory)
  sanitizeAskContext(event)
  assert.ok(JSON.stringify(event.messages).includes('"tool-call"'))
})

// ---------------------------------------------------------------------------
// Generator ask — failures and cleanup
// ---------------------------------------------------------------------------

test("hook did not run surfaces a retryable error and cleans the pending marker", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const input = { sessionID: "ses_parent", question: "q?", exchanges: [] }
  const promise = gen.ask(input, new AbortController().signal)
  await settle()
  const marker = state.generates[0].args.prompt
  state.generates[0].d.resolve({ text: "orphan answer" })
  await assert.rejects(promise, /did not run/)

  // Pending was cleaned: the stale marker no longer matches anything.
  const replay = generateEvent("ses_parent", marker)
  gen.hook(replay)
  assert.equal(replay.messages.length, 1)
})

test("blank answer text is rejected", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const promise = gen.ask(
    { sessionID: "ses_parent", question: "q?", exchanges: [] },
    new AbortController().signal,
  )
  await settle()
  gen.hook(generateEvent("ses_parent", state.generates[0].args.prompt))
  state.generates[0].d.resolve({ text: "   " })
  await assert.rejects(promise, /returned no text/)
})

test("parent location mismatch refuses to generate (no generate call)", async () => {
  const state = mockCtx({ directory: "/repo", workspace: "ws-1" })
  state.ctx.session.get = () =>
    Promise.resolve({ location: { directory: "/moved-elsewhere", workspaceID: "ws-1" } })
  const gen = createGenerator(state.ctx as any)
  await assert.rejects(
    gen.ask({ sessionID: "ses_parent", question: "q?", exchanges: [] }, new AbortController().signal),
    /parent moved/,
  )
  assert.equal(state.generates.length, 0)

  const state2 = mockCtx({ directory: "/repo", workspace: "ws-1" })
  state2.ctx.session.get = () =>
    Promise.resolve({ location: { directory: "/repo", workspaceID: "ws-2" } })
  const gen2 = createGenerator(state2.ctx as any)
  await assert.rejects(
    gen2.ask({ sessionID: "ses_parent", question: "q?", exchanges: [] }, new AbortController().signal),
    /parent moved/,
  )
  assert.equal(state2.generates.length, 0)
})

test("external abort propagates to the inner generate signal and rejects the ask", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const external = new AbortController()
  const promise = gen.ask(
    { sessionID: "ses_parent", question: "q?", exchanges: [] },
    external.signal,
  )
  await settle()
  assert.equal(state.generates.length, 1)
  assert.ok(!state.generates[0].options.signal.aborted)
  external.abort(new Error("user closed the aside"))
  assert.ok(state.generates[0].options.signal.aborted)
  await assert.rejects(promise, /user closed the aside/)
})

test("dispose aborts in-flight asks and clears pending", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const promise = gen.ask(
    { sessionID: "ses_parent", question: "q?", exchanges: [] },
    new AbortController().signal,
  )
  await settle()
  gen.dispose()
  assert.ok(state.generates[0].options.signal.aborted)
  await assert.rejects(promise)
})

// ---------------------------------------------------------------------------
// Request-scoped cancel (V2 RPC HTTP abort)
// ---------------------------------------------------------------------------

test("explicit cancel reaches the in-flight generate's inner signal", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const promise = gen.ask(
    { sessionID: "ses_parent", requestID: "req-1", question: "q?", exchanges: [] },
    new AbortController().signal,
  )
  await settle()
  assert.equal(state.generates.length, 1)
  assert.ok(!state.generates[0].options.signal.aborted)

  assert.deepEqual(gen.cancel({ sessionID: "ses_parent", requestID: "req-1" }), { cancelled: true })
  assert.ok(
    state.generates[0].options.signal.aborted,
    "the inner generate signal must be aborted so the provider request stops",
  )
  await assert.rejects(promise)

  // The key is freed on settle: the same requestID can run again afterwards.
  const retry = gen.ask(
    { sessionID: "ses_parent", requestID: "req-1", question: "q?", exchanges: [] },
    new AbortController().signal,
  )
  await settle()
  assert.equal(state.generates.length, 2)
  gen.hook(generateEvent("ses_parent", state.generates[1].args.prompt))
  state.generates[1].d.resolve({ text: "answered" })
  assert.deepEqual(await retry, { text: "answered", model: "acme/m1" })
})

test("cancel before ask leaves a tombstone that suppresses the generation", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  assert.deepEqual(gen.cancel({ sessionID: "ses_parent", requestID: "req-early" }), { cancelled: true })

  // The cancel HTTP request overtook ask: the tombstone must swallow it.
  await assert.rejects(
    gen.ask(
      { sessionID: "ses_parent", requestID: "req-early", question: "q?", exchanges: [] },
      new AbortController().signal,
    ),
    (error: any) => error instanceof DOMException && error.name === "AbortError" && /cancelled/.test(error.message),
  )
  assert.deepEqual(state.sessionGets, [], "suppressed ask must not reach the client")
  assert.equal(state.generates.length, 0)

  // The tombstone is consumed, not sticky: the same ID can ask again.
  const promise = gen.ask(
    { sessionID: "ses_parent", requestID: "req-early", question: "q?", exchanges: [] },
    new AbortController().signal,
  )
  await settle()
  assert.equal(state.generates.length, 1)
  gen.hook(generateEvent("ses_parent", state.generates[0].args.prompt))
  state.generates[0].d.resolve({ text: "answered" })
  assert.deepEqual(await promise, { text: "answered", model: "acme/m1" })
})

test("wrong session with the same requestID does not cancel the other request", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const promise = gen.ask(
    { sessionID: "ses_A", requestID: "req-shared", question: "qA?", exchanges: [] },
    new AbortController().signal,
  )
  await settle()
  assert.equal(state.generates.length, 1)

  gen.cancel({ sessionID: "ses_B", requestID: "req-shared" })
  assert.ok(
    !state.generates[0].options.signal.aborted,
    "another session's cancel must not abort this request",
  )

  // A completes normally.
  gen.hook(generateEvent("ses_A", state.generates[0].args.prompt))
  state.generates[0].d.resolve({ text: "answer A" })
  assert.deepEqual(await promise, { text: "answer A", model: "acme/m1" })

  // The tombstone belongs to ses_B:req-shared and suppresses only that key.
  await assert.rejects(
    gen.ask(
      { sessionID: "ses_B", requestID: "req-shared", question: "qB?", exchanges: [] },
      new AbortController().signal,
    ),
    (error: any) => error.name === "AbortError",
  )
  assert.equal(state.generates.length, 1, "suppressed ask must not reach the client")
})

test("overlapping ask with the same requestID rejects without replacing the active controller", async () => {
  const state = mockCtx()
  const gen = createGenerator(state.ctx as any)
  const input = { sessionID: "ses_parent", requestID: "req-dup", question: "q?", exchanges: [] }
  const first = gen.ask(input, new AbortController().signal)
  await settle()
  assert.equal(state.generates.length, 1)

  await assert.rejects(gen.ask({ ...input }, new AbortController().signal), /already running/)

  // The original controller must still be the registered one: a cancel now
  // reaches the FIRST request, proving it was not replaced by the duplicate.
  assert.ok(!state.generates[0].options.signal.aborted)
  gen.cancel({ sessionID: "ses_parent", requestID: "req-dup" })
  assert.ok(state.generates[0].options.signal.aborted, "original controller must not have been replaced")
  await assert.rejects(first)
})

// ---------------------------------------------------------------------------
// Aside — happy path
// ---------------------------------------------------------------------------

test("ask records the exchange, clears the draft, and records the model", async () => {
  const { ports, asks } = mockPorts()
  const aside = createAside("ses_parent", ports)
  aside.draft("  what does this do?  ")
  const promise = aside.ask()
  await settle()
  assert.equal(aside.get().status, "generating")
  assert.equal(asks.length, 1)
  assert.equal(asks[0].input.question, "what does this do?")
  assert.equal(asks[0].input.sessionID, "ses_parent")
  assert.deepEqual(asks[0].input.exchanges, [])
  asks[0].d.resolve({ text: "it does things", model: "acme/m1" })
  await promise

  const state = aside.get()
  assert.equal(state.status, "editing")
  assert.equal(state.draft, "")
  assert.equal(state.model, "acme/m1")
  assert.deepEqual(state.exchanges, [
    { question: "what does this do?", answer: "it does things", time: state.exchanges[0].time },
  ])
})

test("ask with blank draft is a no-op", async () => {
  const { ports, asks } = mockPorts()
  const aside = createAside("ses_parent", ports)
  aside.draft("   ")
  await aside.ask()
  assert.equal(asks.length, 0)
  assert.equal(aside.get().status, "editing")
})

// ---------------------------------------------------------------------------
// Aside — cancel followed by new request: stale answer ignored
// ---------------------------------------------------------------------------

test("cancel then re-ask: stale answer must not land in the new request", async () => {
  const { ports, asks } = mockPorts()
  const aside = createAside("ses_parent", ports)
  aside.draft("first question")
  const p1 = aside.ask()
  await settle()
  assert.equal(aside.get().status, "generating")

  aside.cancel()
  assert.equal(aside.get().status, "editing")
  assert.equal(aside.get().draft, "first question") // draft saved across cancel
  assert.ok(asks[0].signal.aborted)

  aside.draft("second question")
  const p2 = aside.ask()
  await settle()
  assert.equal(asks.length, 2)
  assert.ok(!asks[1].signal.aborted)

  // The stale first answer resolves while the second request is in flight.
  asks[0].d.resolve({ text: "stale answer", model: "m-stale" })
  await p1
  assert.equal(aside.get().status, "generating") // stale settle must not clobber state
  assert.deepEqual(aside.get().exchanges, [])
  assert.equal(aside.get().draft, "second question")

  asks[1].d.resolve({ text: "real answer", model: "m-real" })
  await p2
  const state = aside.get()
  assert.equal(state.status, "editing")
  assert.deepEqual(state.exchanges.map((e: any) => e.question), ["second question"])
  assert.equal(state.exchanges[0].answer, "real answer")
  assert.equal(state.model, "m-real")
})

// ---------------------------------------------------------------------------
// Aside — saved drafts and retry without losing answers
// ---------------------------------------------------------------------------

test("failed ask keeps the draft and prior answers; retry appends cleanly", async () => {
  const { ports, asks } = mockPorts()
  const aside = createAside("ses_parent", ports)

  // First exchange succeeds.
  aside.draft("first?")
  let p = aside.ask()
  await settle()
  asks[0].d.resolve({ text: "answer one", model: "m" })
  await p
  assert.equal(aside.get().exchanges.length, 1)

  // Second ask fails.
  aside.draft("second?")
  p = aside.ask()
  await settle()
  asks[1].d.reject(new Error("upstream exploded"))
  await p
  let state = aside.get()
  assert.equal(state.status, "editing")
  assert.equal(state.error, "upstream exploded")
  assert.equal(state.draft, "second?") // question saved for retry
  assert.deepEqual(state.exchanges.map((e: any) => e.question), ["first?"])

  // Retry succeeds; nothing lost.
  p = aside.ask()
  await settle()
  assert.equal(asks.length, 3)
  assert.equal(asks[2].input.question, "second?")
  assert.deepEqual(asks[2].input.exchanges.map((e: any) => e.question), ["first?"])
  asks[2].d.resolve({ text: "answer two", model: "m" })
  await p
  state = aside.get()
  assert.equal(state.error, "")
  assert.deepEqual(state.exchanges.map((e: any) => e.answer), ["answer one", "answer two"])
})

test("blank answer is treated as a failure with the draft saved", async () => {
  const { ports, asks } = mockPorts()
  const aside = createAside("ses_parent", ports)
  aside.draft("still here?")
  const p = aside.ask()
  await settle()
  asks[0].d.resolve({ text: "   ", model: "m" })
  await p
  const state = aside.get()
  assert.match(state.error, /returned no text/)
  assert.equal(state.draft, "still here?")
  assert.deepEqual(state.exchanges, [])
  assert.equal(state.status, "editing")

  // Retry with a real answer works.
  const p2 = aside.ask()
  await settle()
  asks[1].d.resolve({ text: "real", model: "m" })
  await p2
  assert.equal(aside.get().exchanges.length, 1)
})

test("non-Error rejections render as text", async () => {
  const { ports, asks } = mockPorts()
  const aside = createAside("ses_parent", ports)
  aside.draft("q?")
  const p = aside.ask()
  await settle()
  asks[0].d.reject({ message: "weird failure shape" })
  await p
  assert.equal(aside.get().error, "weird failure shape")
})

// ---------------------------------------------------------------------------
// Aside — limits
// ---------------------------------------------------------------------------

test("over-long question is rejected before any ask call", async () => {
  const { ports, asks } = mockPorts()
  const aside = createAside("ses_parent", ports)
  aside.draft("x".repeat(MAX_QUESTION + 1))
  await aside.ask()
  assert.equal(asks.length, 0)
  assert.match(aside.get().error, /under/)
  assert.equal(aside.get().status, "editing")
  // Draft is retained so the user can trim instead of retyping.
  assert.equal(aside.get().draft.length, MAX_QUESTION + 1)
})

test("aside refuses new questions after MAX_EXCHANGES", async () => {
  const { ports, asks } = mockPorts()
  const aside = createAside("ses_parent", ports)
  for (let i = 0; i < MAX_EXCHANGES; i++) {
    aside.draft(`q${i}?`)
    const p = aside.ask()
    await settle()
    asks[i].d.resolve({ text: `a${i}`, model: "m" })
    await p
  }
  assert.equal(aside.get().exchanges.length, MAX_EXCHANGES)

  aside.draft("one more?")
  await aside.ask()
  assert.equal(asks.length, MAX_EXCHANGES) // no 25th port call
  assert.match(aside.get().error, /full/)
})

test("aside refuses new questions once the transcript budget is exceeded", async () => {
  const { ports, asks } = mockPorts()
  const aside = createAside("ses_parent", ports)
  // One exchange whose answer alone pushes the running total past
  // MAX_TRANSCRIPT - 128_000 - MAX_QUESTION.
  aside.draft("big?")
  const p = aside.ask()
  await settle()
  asks[0].d.resolve({ text: "x".repeat(100_001), model: "m" })
  await p
  assert.equal(aside.get().exchanges.length, 1)

  aside.draft("again?")
  await aside.ask()
  assert.equal(asks.length, 1)
  assert.match(aside.get().error, /full/)
})

// ---------------------------------------------------------------------------
// Aside — expand: single flight, operation-ID reuse, retry
// ---------------------------------------------------------------------------

test("concurrent expands create one fork; later calls reuse the completed result", async () => {
  const { ports, asks, expands } = mockPorts()
  const aside = createAside("ses_parent", ports)
  aside.draft("q?")
  const setup = aside.ask()
  await settle()
  asks[0].d.resolve({ text: "a", model: "m" })
  await setup

  const e1 = aside.expand()
  await settle()
  assert.equal(aside.get().status, "expanding")
  void aside.expand() // concurrent caller joins nothing observable; port stays single-flight
  await settle()
  assert.equal(expands.length, 1, "second expand must join the in-flight one")
  assert.match(expands[0].input.operationID, /^[0-9a-f-]{36}$/)
  assert.equal(expands[0].input.sessionID, "ses_parent")
  assert.deepEqual(expands[0].input.exchanges.map((e: any) => e.question), ["q?"])

  expands[0].d.resolve({ sessionID: "ses_fork" })
  assert.equal(await e1, "ses_fork")
  assert.equal(aside.get().status, "expanded")
  assert.equal(aside.get().forkID, "ses_fork")

  // Post-success expand returns the cached fork without a port call.
  assert.equal(await aside.expand(), "ses_fork")
  assert.equal(expands.length, 1)
})

test("expand retry after failure reuses the same operation ID", async () => {
  const { ports, asks, expands } = mockPorts()
  const aside = createAside("ses_parent", ports)
  aside.draft("q?")
  const setup = aside.ask()
  await settle()
  asks[0].d.resolve({ text: "a", model: "m" })
  await setup

  // First expand fails with an ambiguous server error.
  const first = aside.expand()
  await settle()
  const operationID = expands[0].input.operationID
  expands[0].d.reject(new Error("HTTP 504 gateway timeout"))
  await first
  let state = aside.get()
  assert.equal(state.status, "editing")
  assert.match(state.error, /504/)
  assert.equal(state.forkID, "")

  // Retry must reuse the operation (idempotent server side).
  const second = aside.expand()
  await settle()
  assert.equal(expands.length, 2)
  assert.equal(expands[1].input.operationID, operationID)
  expands[1].d.resolve({ sessionID: "ses_fork" })
  assert.equal(await second, "ses_fork")
  assert.equal(aside.get().status, "expanded")
})

test("expand with no exchanges is a no-op", async () => {
  const { ports, expands } = mockPorts()
  const aside = createAside("ses_parent", ports)
  assert.equal(await aside.expand(), undefined)
  assert.equal(expands.length, 0)
})

// ---------------------------------------------------------------------------
// Aside — reset guard rails
// ---------------------------------------------------------------------------

test("reset while editing clears all state", async () => {
  const { ports, asks } = mockPorts()
  const aside = createAside("ses_parent", ports)
  aside.draft("q?")
  const p = aside.ask()
  await settle()
  asks[0].d.resolve({ text: "a", model: "m" })
  await p
  assert.equal(aside.get().exchanges.length, 1)

  aside.reset()
  const state = aside.get()
  assert.equal(state.draft, "")
  assert.deepEqual(state.exchanges, [])
  assert.equal(state.status, "editing")
  assert.equal(state.error, "")
  assert.equal(state.forkID, "")
  assert.equal(state.promotionID, "")
  assert.equal(state.model, "")
})

test("reset while expanding is a no-op; promotion completes afterwards", async () => {
  const { ports, asks, expands } = mockPorts()
  const aside = createAside("ses_parent", ports)
  aside.draft("q?")
  const setup = aside.ask()
  await settle()
  asks[0].d.resolve({ text: "a", model: "m" })
  await setup

  const expanding = aside.expand()
  await settle()
  aside.reset() // must NOT clear: the promotion may have committed server-side
  assert.equal(aside.get().status, "expanding")
  expands[0].d.resolve({ sessionID: "ses_fork" })
  assert.equal(await expanding, "ses_fork")
  assert.equal(aside.get().forkID, "ses_fork")
})

test("reset after a failed expand is blocked (promotionID without forkID)", async () => {
  const { ports, asks, expands } = mockPorts()
  const aside = createAside("ses_parent", ports)
  aside.draft("q?")
  const setup = aside.ask()
  await settle()
  asks[0].d.resolve({ text: "a", model: "m" })
  await setup

  const expanding = aside.expand()
  await settle()
  const operationID = expands[0].input.operationID
  expands[0].d.reject(new Error("boom"))
  await expanding

  aside.reset()
  const state = aside.get()
  assert.equal(state.promotionID, operationID) // retained for retry
  assert.deepEqual(state.exchanges.map((e: any) => e.question), ["q?"])
  assert.match(state.error, /boom/)
})

test("reset after a completed expansion clears everything", async () => {
  const { ports, asks, expands } = mockPorts()
  const aside = createAside("ses_parent", ports)
  aside.draft("q?")
  const setup = aside.ask()
  await settle()
  asks[0].d.resolve({ text: "a", model: "m" })
  await setup
  const expanding = aside.expand()
  await settle()
  expands[0].d.resolve({ sessionID: "ses_fork" })
  await expanding
  assert.equal(aside.get().status, "expanded")

  aside.reset()
  const state = aside.get()
  assert.equal(state.status, "editing")
  assert.equal(state.forkID, "")
  assert.equal(state.promotionID, "")
  assert.deepEqual(state.exchanges, [])
})

test("reset while generating cancels the in-flight ask; stale answer ignored", async () => {
  const { ports, asks } = mockPorts()
  const aside = createAside("ses_parent", ports)
  aside.draft("q?")
  const p = aside.ask()
  await settle()
  aside.reset()
  assert.ok(asks[0].signal.aborted)
  assert.equal(aside.get().status, "editing")
  assert.equal(aside.get().draft, "")

  // Late answer from the aborted request must not resurrect state.
  asks[0].d.resolve({ text: "ghost answer", model: "m" })
  await p
  const state = aside.get()
  assert.deepEqual(state.exchanges, [])
  assert.equal(state.status, "editing")
})
