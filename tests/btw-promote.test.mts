/**
 * Regression tests for the BTW promotion pipeline (promote.ts).
 *
 * Run from the repo root:
 *   npm test
 *   node --experimental-strip-types --test tests/btw-promote.test.mts
 *
 * Exercises the REAL createPromoter against a small mock client whose method
 * signatures mirror @opencode/client 2.0.3 exactly (SessionInfo, SessionsResponse,
 * AgentGetOutput, PermissionRulesInput, SessionSyntheticInput, ...). No live
 * network, no service, no model calls.
 *
 * The headline guarantees:
 *   - Promotion writes ONLY the fork: no parent writes, no generation.
 *   - The carry-over is one queued fork prompt (resume:false — zero inference),
 *     with a deterministic message ID so retries never duplicate it.
 *   - Fork boundary is "latest through" ({ type: "through" }).
 *   - Fork permissions are cleared BEFORE switching the fork to the ask agent.
 *   - Synthetic backfill is deterministic (resume: false, stable message ID)
 *     so retries never duplicate content.
 *   - A lost fork response is recovered by explicit candidate selection —
 *     never by creating a second fork.
 *   - A new operation after a completed promotion starts a fresh fork.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createPromoter } from "../src/promote.ts"
import { transcript } from "../src/aside.ts"

const DIRECTORY = "/repo"
const PARENT = "ses_parent"
const OPERATION = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
const OPERATION_2 = "5f9c9a4e-4f89-11d3-9a0c-0305e82c3302"
const EXCHANGES = [
  { question: "why is the sky blue?", answer: "Rayleigh scattering.", time: 1 },
]

/** SessionInfo with only the fields the promoter (and list filters) read. */
function sessionInfo(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    projectID: "proj_1",
    cost: { amount: 0, currency: "USD" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 },
    time: { created: 1, updated: 2 },
    location: { directory: DIRECTORY, workspaceID: "ws_1" },
    ...over,
  }
}

/** AgentInfo matching the canonical ask.md profile (what validateAsk reads). */
function agentInfo() {
  return {
    id: "ask",
    name: "ask",
    request: {},
    system: "Answer the user's question using the context already available.",
    mode: "primary",
    hidden: false,
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
  }
}

function promotionInput(over: Record<string, unknown> = {}) {
  return { sessionID: PARENT, operationID: OPERATION, exchanges: structuredClone(EXCHANGES), ...over }
}

/**
 * Full mock client + environment. `state.forkError` simulates a fork RPC
 * failure AFTER the server-side fork was created (lost/ambiguous response);
 * the fork session still lands in `state.roots` like the real server.
 */
function createEnv() {
  const log: { path: string; input: any }[] = []
  const record = (path: string, input: any) => log.push({ path, input })
  let forkCounter = 0

  const state = {
    parent: sessionInfo(PARENT),
    // Root sessions in this directory as session.list returns them.
    roots: [] as any[],
    // Parent context messages (session.context). Non-empty by default.
    context: [{ id: "msg_1", role: "user", time: { created: 1 } }] as any[],
    agent: agentInfo() as any,
    forkError: undefined as any,
    promptError: undefined as any,
  }

  const client: any = {
    session: {
      get: async (input: any) => { record("session.get", input); return structuredClone(state.parent) },
      list: async (input: any) => {
        record("session.list", input)
        return { data: structuredClone(state.roots), cursor: {} }
      },
      context: async (input: any) => { record("session.context", input); return structuredClone(state.context) },
      fork: async (input: any) => {
        record("session.fork", input)
        const fork = sessionInfo(`ses_fork_${++forkCounter}`, {
          fork: { sessionID: input.sessionID, boundary: input.boundary },
        })
        state.roots.push(fork) // server-side effect survives a lost response
        if (state.forkError) throw state.forkError
        return structuredClone(fork)
      },
      switchAgent: async (input: any) => { record("session.switchAgent", input) },
      rename: async (input: any) => { record("session.rename", input) },
      // The ONLY permitted prompt is the fork carry-over (queued, resume:false).
      // Prompting the parent is a hard failure.
      prompt: async (input: any) => {
        record("session.prompt", input)
        if (input.sessionID === PARENT) throw new Error("promotion must never prompt the parent")
        if (state.promptError) throw state.promptError
        return { id: input.id, sessionID: input.sessionID }
      },
      // Promotion must never trigger generation on the parent or the fork.
      generate: async (input: any) => { record("session.generate", input); throw new Error("promotion must never generate") },
      interrupt: async (input: any) => { record("session.interrupt", input) },
    },
    permission: {
      rules: async (input: any) => { record("permission.rules", input) },
    },
    agent: {
      get: async (input: any) => {
        record("agent.get", input)
        return { location: { directory: DIRECTORY, workspaceID: "ws_1" }, data: structuredClone(state.agent) }
      },
    },
  }

  const recoverCalls: any[][] = []
  const env = {
    client,
    log,
    state,
    recoverCalls,
    // Default recovery: pick the first candidate (what a picker UI would do).
    recoverImpl: async (candidates: any[]) => candidates[0]?.id,
  }
  const recover = async (candidates: any[]) => {
    recoverCalls.push(structuredClone(candidates))
    return env.recoverImpl(candidates)
  }
  const promote = createPromoter(client, recover)

  const paths = () => log.map((e) => e.path)
  const callsOf = (path: string) => log.filter((e) => e.path === path).map((e) => e.input)
  return { promote, env, paths, callsOf, log }
}

// ---------------------------------------------------------------------------
// Happy path: fork-only writes, zero parent writes / generation
// ---------------------------------------------------------------------------

test("promotion writes only the fork: exact call choreography, one queued carry-over prompt", async () => {
  const { promote, paths, callsOf } = createEnv()
  const result = await promote(promotionInput())

  assert.deepEqual(paths(), [
    "session.get",          // parent read
    "agent.get",            // ask agent read + validate
    "session.context",      // parent read (non-empty guard)
    "session.list",         // baseline fork snapshot (`before`)
    "session.fork",         // the only mutation trigger
    "permission.rules",     // fork write
    "session.switchAgent",  // fork write
    "session.rename",       // fork write
    "session.prompt",       // fork write: queued carry-over, no inference
  ])
  // No generation or interruption happened (mocks throw if they did, and the
  // log proves they were never even attempted).
  assert.deepEqual(callsOf("session.generate"), [])
  assert.deepEqual(callsOf("session.interrupt"), [])
  assert.equal(callsOf("session.prompt").length, 1)

  // Every write after the fork targets the fork, never the parent.
  for (const path of ["permission.rules", "session.switchAgent", "session.rename", "session.prompt"]) {
    const [input] = callsOf(path)
    assert.equal(input.sessionID, "ses_fork_1", `${path} must target the fork`)
  }
  const [forkInput] = callsOf("session.fork")
  assert.equal(forkInput.sessionID, PARENT)
  assert.equal(result.sessionID, "ses_fork_1")
})

test("fork uses the latest-through boundary", async () => {
  const fresh = createEnv()
  await fresh.promote(promotionInput())
  assert.deepEqual(fresh.callsOf("session.fork")[0], {
    sessionID: PARENT,
    boundary: { type: "through" },
  })
})

test("fork permissions are cleared before switching to the ask agent", async () => {
  const fresh = createEnv()
  await fresh.promote(promotionInput())
  assert.deepEqual(fresh.callsOf("permission.rules")[0], { sessionID: "ses_fork_1", permissions: [] })
  const order = fresh.paths()
  assert.ok(
    order.indexOf("permission.rules") < order.indexOf("session.switchAgent"),
    "permission.rules must run before session.switchAgent",
  )
  assert.equal(fresh.callsOf("session.switchAgent")[0].agent, "ask")
})

test("rename derives the fork title from the first question", async () => {
  const fresh = createEnv()
  await fresh.promote(promotionInput())
  assert.equal(fresh.callsOf("session.rename")[0].title, "BTW: why is the sky blue?")
})

// ---------------------------------------------------------------------------
// Carry-over prompt: resume:false, stable message ID, transcript payload
// ---------------------------------------------------------------------------

test("carry-over prompt is queued (resume:false) with a deterministic ID and the transcript", async () => {
  const fresh = createEnv()
  await fresh.promote(promotionInput())
  const [input] = fresh.callsOf("session.prompt")
  assert.equal(input.sessionID, "ses_fork_1")
  assert.equal(input.id, `msg_btw_${OPERATION}`)
  assert.equal(input.resume, false)
  assert.equal(input.delivery, "steer")
  assert.deepEqual(input.metadata, { btw: true, operationID: OPERATION, parentID: PARENT, exchanges: 1 })
  assert.equal(input.text, transcript(EXCHANGES, PARENT))
  assert.ok(input.text.includes(`fork of session \`${PARENT}\``), "carry-over must name the parent session")
})

test("failed carry-over prompt retries the same fork with the same message ID, no second fork", async () => {
  const fresh = createEnv()
  fresh.env.state.promptError = new Error("connection reset")
  await assert.rejects(fresh.promote(promotionInput()), /connection reset/)
  // Retry after the transport healed: same operation, fork already known.
  fresh.env.state.promptError = undefined
  const result = await fresh.promote(promotionInput())

  assert.equal(fresh.callsOf("session.fork").length, 1, "retry must not fork again")
  assert.equal(result.sessionID, "ses_fork_1")
  const promptCalls = fresh.callsOf("session.prompt")
  assert.equal(promptCalls.length, 2)
  assert.equal(promptCalls[0].id, promptCalls[1].id)
  assert.equal(promptCalls[1].id, `msg_btw_${OPERATION}`)
  assert.deepEqual(promptCalls[1].resume, false)
  // Retry goes straight to the fork writes — no re-validation, no re-fork.
  assert.deepEqual(fresh.paths().slice(-4), [
    "permission.rules", "session.switchAgent", "session.rename", "session.prompt",
  ])
})

// ---------------------------------------------------------------------------
// Lost fork response: explicit recovery, never a second fork
// ---------------------------------------------------------------------------

test("lost fork response recovers by explicit candidate selection without re-forking", async () => {
  const fresh = createEnv()
  // Pre-existing sessions that must be excluded from candidates.
  fresh.env.state.roots = [
    sessionInfo("ses_unrelated"), // unrelated root in the same directory
    sessionInfo("ses_old_fork", { fork: { sessionID: PARENT, boundary: { type: "through" } } }),
  ]
  // The fork commits server-side but the response is lost (transport error).
  fresh.env.state.forkError = new Error("fetch failed: socket hang up")
  await assert.rejects(fresh.promote(promotionInput()), /socket hang up/)

  // Retry: exactly one new candidate (the fork created moments ago).
  const result = await fresh.promote(promotionInput())
  assert.equal(fresh.env.recoverCalls.length, 1, "recovery must ask the picker exactly once")
  assert.deepEqual(fresh.env.recoverCalls[0].map((s: any) => s.id), ["ses_fork_1"])
  assert.equal(fresh.callsOf("session.fork").length, 1, "recovery must never create a second fork")
  assert.equal(result.sessionID, "ses_fork_1")
  // The recovered fork gets the full write choreography.
  assert.deepEqual(fresh.callsOf("permission.rules")[0], { sessionID: "ses_fork_1", permissions: [] })
  assert.equal(fresh.callsOf("session.prompt")[0].id, `msg_btw_${OPERATION}`)
})

test("unrelated or missing recovery selection is rejected; the aside stays saved and no fork is created", async () => {
  const fresh = createEnv()
  fresh.env.state.forkError = new Error("ambiguous network failure")
  await assert.rejects(fresh.promote(promotionInput()), /ambiguous/)

  // Picker cancelled: no selection.
  fresh.env.recoverImpl = async () => undefined
  await assert.rejects(fresh.promote(promotionInput()), /Select the created fork/)
  // Picker returns something that is NOT one of the candidates.
  fresh.env.recoverImpl = async () => "ses_other"
  await assert.rejects(fresh.promote(promotionInput()), /Select the created fork/)

  // Still no duplicate fork, and a correct selection finishes the promotion.
  assert.equal(fresh.callsOf("session.fork").length, 1)
  fresh.env.recoverImpl = async (candidates) => candidates[0]?.id
  const result = await fresh.promote(promotionInput())
  assert.equal(result.sessionID, "ses_fork_1")
  assert.equal(fresh.callsOf("session.fork").length, 1)
})

test("a definitive 4xx fork rejection re-forks on retry instead of recovering", async () => {
  const fresh = createEnv()
  fresh.env.state.forkError = Object.assign(new Error("conflict"), { status: 409 })
  await assert.rejects(fresh.promote(promotionInput()), /conflict/)

  // 4xx is definitive: the attempt is reset, so the retry forks fresh.
  fresh.env.state.forkError = undefined
  const result = await fresh.promote(promotionInput())
  assert.equal(fresh.callsOf("session.fork").length, 2)
  assert.deepEqual(fresh.env.recoverCalls, [], "4xx must not enter the recovery path")
  assert.equal(result.sessionID, "ses_fork_2")
})

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("empty parent context refuses to fork; a later retry with context succeeds", async () => {
  const fresh = createEnv()
  fresh.env.state.context = []
  await assert.rejects(fresh.promote(promotionInput()), /first completed message/)
  // No fork, no fork writes.
  assert.deepEqual(fresh.paths(), ["session.get", "agent.get", "session.context"])

  // Once the parent has a completed message, the retry proceeds normally.
  fresh.env.state.context = [{ id: "msg_1", role: "user", time: { created: 1 } }]
  const result = await fresh.promote(promotionInput())
  assert.equal(result.sessionID, "ses_fork_1")
  assert.equal(fresh.callsOf("session.fork").length, 1)
})

test("an invalid ask agent is rejected before any fork or write", async () => {
  const fresh = createEnv()
  fresh.env.state.agent = { ...agentInfo(), mode: "subordinate" }
  await assert.rejects(fresh.promote(promotionInput()), /visible primary agent/)
  assert.deepEqual(fresh.paths(), ["session.get", "agent.get"])
})

test("switching operation before the previous promotion finishes is refused", async () => {
  const fresh = createEnv()
  fresh.env.state.forkError = new Error("lost response")
  await assert.rejects(fresh.promote(promotionInput()), /lost response/)

  await assert.rejects(
    fresh.promote(promotionInput({ operationID: OPERATION_2 })),
    /Finish the previous fork promotion/,
  )
  assert.equal(fresh.callsOf("session.fork").length, 1)
})

// ---------------------------------------------------------------------------
// New operation after success
// ---------------------------------------------------------------------------

test("a new operation after a completed promotion forks fresh and completes", async () => {
  const fresh = createEnv()
  const first = await fresh.promote(promotionInput())
  assert.equal(first.sessionID, "ses_fork_1")

  const exchanges2 = [{ question: "and the sunset?", answer: "Rayleigh again, redder.", time: 2 }]
  const second = await fresh.promote(
    promotionInput({ operationID: OPERATION_2, exchanges: exchanges2 }),
  )
  assert.equal(second.sessionID, "ses_fork_2")
  assert.equal(fresh.callsOf("session.fork").length, 2)
  assert.deepEqual(fresh.callsOf("session.fork")[1], {
    sessionID: PARENT,
    boundary: { type: "through" },
  })
  // The second fork's carry-over carries the NEW operation's ID and transcript.
  const promptCalls = fresh.callsOf("session.prompt")
  assert.equal(promptCalls[1].id, `msg_btw_${OPERATION_2}`)
  assert.equal(promptCalls[1].sessionID, "ses_fork_2")
  assert.equal(promptCalls[1].text, transcript(exchanges2, PARENT))
  assert.equal(fresh.callsOf("session.rename")[1].title, "BTW: and the sunset?")
})

test("a completed promotion returns the cached fork without any client calls", async () => {
  const fresh = createEnv()
  await fresh.promote(promotionInput())
  const before = fresh.log.length
  const again = await fresh.promote(promotionInput())
  assert.equal(again.sessionID, "ses_fork_1")
  assert.equal(fresh.log.length, before, "repeat of the same operation must be a pure cache hit")
})
