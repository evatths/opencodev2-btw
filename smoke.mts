/** Explicit integration smoke: real V2 service, local fake model, disposable sessions. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { once } from "node:events"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { Btw } from "./src/rpc.ts"
import { createPromoter } from "./src/promote.ts"
import { validateAsk } from "./src/generate.ts"

const endpoint = await Service.discover()
assert(endpoint, "Start the normal OpenCode service before running this explicit smoke test.")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const requests: any[] = []
let slowStarted: (() => void) | undefined
let slowClosed: (() => void) | undefined
let parentStarted: (() => void) | undefined
let finishParent: (() => void) | undefined
const mock = createServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  const payload = JSON.parse(body)
  requests.push(payload)
  if (JSON.stringify(payload.messages.at(-1)).includes("CANCEL_PROBE")) {
    res.on("close", () => slowClosed?.())
    slowStarted?.()
    return
  }
  const content = "Fixture answer: the recorded decision is blue."
  if (payload.stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    const busyParent = JSON.stringify(payload.messages.at(-1)).includes("BUSY_PARENT_PROBE")
    res.write(`data: ${JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: busyParent ? "UNFINISHED_PARENT_SENTINEL" : content }, finish_reason: null }] })}\n\n`)
    const finish = () => {
      res.write(`data: ${JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`)
      res.end("data: [DONE]\n\n")
    }
    if (busyParent) { finishParent = finish; parentStarted?.() }
    else finish()
  } else {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }))
  }
})
mock.listen(0, "127.0.0.1")
await once(mock, "listening")
const address = mock.address()
assert(address && typeof address !== "string")
const directory = await realpath(await mkdtemp(join(tmpdir(), "opencode/btw-smoke-")))
const sessions: string[] = []
try {
  await writeFile(join(directory, "opencode.json"), JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    // This smoke needs the plugin globally installed (v2.0.3 loads package
    // plugins only from the config dir; location configs and symlinks are not
    // supported). Run `npm run dev:install` first after any source change.
    // V2.0.3's global provider allowlist wins over local allowlists. Reuse an
    // allowed ID, with its endpoint overridden only in this disposable location.
    enabled_providers: ["applied"],
    model: "applied/btw-fixture",
    providers: { applied: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture" }, models: { "btw-fixture": { limit: { context: 1000000, output: 8000 }, capabilities: { tools: true, input: ["text"], output: ["text"] } } } } },
    agents: Object.fromEntries(["build", "title", "summary", "compaction"].map((id) => [id, { model: "applied/btw-fixture" }])),
  }))
  const location = { directory }
  // Fresh locations expose list/get endpoints before async plugins/agents are ready.
  await client.plugin.awaitActivation({ location }, { signal: AbortSignal.timeout(15000) })
  const plugins = await client.plugin.list({ location })
  console.log("Plugin discovery:", JSON.stringify(plugins.data.filter((p: any) => JSON.stringify(p).includes("btw"))))
  const ask = (await client.agent.get({ agentID: "ask", location })).data
  validateAsk(ask)
  assert.match(ask.name, /^ask$/i)
  console.log("PASS: canonical Ask profile, picker name and no-tools policy")
  const parent = await client.session.create({ location, title: "BTW disposable smoke", agent: "build", model: { providerID: "applied", id: "btw-fixture" } })
  sessions.push(parent.id)
  await client.session.prompt({ sessionID: parent.id, text: "The recorded decision is blue. Acknowledge briefly." })
  await client.session.wait({ sessionID: parent.id })
  const before = await client.session.get({ sessionID: parent.id })
  const contextBefore = await client.session.context({ sessionID: parent.id })
  assert(contextBefore.some((m) => m.type === "assistant"))
  const inboxBefore = await client.session.inbox.list({ sessionID: parent.id })
  const rpc = client.rpc(Btw)
  const answer = await rpc.ask({ sessionID: parent.id, question: "What was the decision?", exchanges: [] }, { location })
  assert.match(answer.text, /blue/)
  const request = requests.at(-1)
  assert.equal(request.tools?.length ?? 0, 0)
  // OpenAI-compatible lowering joins SystemParts into one system message.
  assert(request.messages[0].content.startsWith(ask.system), "Ask must replace the base prompt while preserving instruction context")
  assert.deepEqual(await client.session.get({ sessionID: parent.id }), before)
  assert.deepEqual(await client.session.context({ sessionID: parent.id }), contextBefore)
  assert.deepEqual(await client.session.inbox.list({ sessionID: parent.id }), inboxBefore)
  console.log("PASS: actual provider request uses Ask, no tools, parent unchanged")

  const exchange = { question: "What was the decision?", answer: answer.text, time: Date.now() }
  await client.session.prompt({ sessionID: parent.id, text: "LATEST_CONTEXT_SENTINEL: The implementation is complete." })
  await client.session.wait({ sessionID: parent.id })
  await rpc.ask({ sessionID: parent.id, question: "Explain your previous answer in light of the latest update.", exchanges: [exchange] }, { location })
  assert(JSON.stringify(requests.at(-1)).includes("LATEST_CONTEXT_SENTINEL"))
  assert(requests.at(-1).messages.some((m: any) => m.role === "assistant" && m.content === answer.text))
  console.log("PASS: follow-up receives newer parent context and prior local answer")

  const started = new Promise<void>((resolve) => { slowStarted = resolve })
  const closed = new Promise<void>((resolve) => { slowClosed = resolve })
  const abort = new AbortController()
  const requestID = crypto.randomUUID()
  const cancelled = rpc.ask({ sessionID: parent.id, requestID, question: "CANCEL_PROBE", exchanges: [] }, { location, signal: abort.signal })
  const rejected = assert.rejects(cancelled)
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error("cancel probe did not reach provider")), 10000).unref())])
  abort.abort()
  await rpc.cancel({ sessionID: parent.id, requestID }, { location })
  await rejected
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("provider request was not cancelled")), 10000).unref())])
  console.log("PASS: cancellation reaches the provider without interrupting the parent")

  const busy = new Promise<void>((resolve) => { parentStarted = resolve })
  await client.session.prompt({ sessionID: parent.id, text: "BUSY_PARENT_PROBE" })
  await Promise.race([busy, new Promise((_, reject) => setTimeout(() => reject(new Error("parent did not start streaming")), 10000).unref())])
  await rpc.ask({ sessionID: parent.id, question: "What did the completed context say?", exchanges: [exchange] }, { location })
  assert(!JSON.stringify(requests.at(-1).messages).includes("UNFINISHED_PARENT_SENTINEL"))
  assert((await client.session.active())[parent.id], "The parent must remain running during the aside")
  console.log("PASS: aside runs beside a busy parent and excludes its unfinished output")

  await client.permission.rules({ sessionID: parent.id, permissions: [{ action: "*", resource: "*", effect: "allow" }] })
  const parentAtFork = await client.session.get({ sessionID: parent.id })
  const count = requests.length
  const promote = createPromoter(client, async () => { throw new Error("Unexpected recovery dialog") })
  const input = { sessionID: parent.id, operationID: crypto.randomUUID(), exchanges: [exchange] }
  const fork = await promote(input)
  sessions.push(fork.sessionID)
  assert.deepEqual(await promote(input), fork)
  assert.equal(requests.length, count)
  const info = await client.session.get({ sessionID: fork.sessionID })
  assert.equal(info.fork?.sessionID, parent.id)
  assert.equal(info.parentID, undefined)
  assert.equal(info.agent, "ask")
  assert.deepEqual(info.permissions, [])
  assert(!JSON.stringify(await client.session.context({ sessionID: fork.sessionID })).includes("UNFINISHED_PARENT_SENTINEL"))
  const pending = await client.session.inbox.list({ sessionID: fork.sessionID })
  assert.equal(pending.length, 1)
  assert.equal(pending[0].type, "user")
  assert.deepEqual(await client.session.get({ sessionID: parent.id }), parentAtFork)
  assert((await client.session.active())[parent.id], "Promotion must not interrupt the parent")
  finishParent!()
  await client.session.wait({ sessionID: parent.id })
  console.log("PASS: busy-parent fork, Ask selected, permissions cleared, Q&A queued, zero promotion model calls")
  await client.session.prompt({ sessionID: fork.sessionID, text: "Continue from the saved BTW answer." })
  await client.session.wait({ sessionID: fork.sessionID })
  const continuation = requests.at(-1)
  assert.equal(continuation.tools?.length ?? 0, 0)
  assert(JSON.stringify(continuation.messages).includes("BTW aside"))
  assert.equal((await client.session.inbox.list({ sessionID: fork.sessionID })).length, 0)
  console.log("PASS: normal Ask turn consumes carried Q&A without tools")
} finally {
  for (const sessionID of sessions.reverse()) await client.session.remove({ sessionID })
  mock.closeAllConnections()
  mock.close()
  await rm(directory, { recursive: true, force: true })
}
