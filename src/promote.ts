import type { OpenCodeClient, SessionInfo } from "@opencode/client"
import { transcript } from "./aside.ts"
import { validateAsk } from "./generate.ts"
import { Promotion } from "./rpc.ts"

type Client = Pick<OpenCodeClient, "session" | "permission" | "agent">

/** All promotion writes target the fork; no prompt or wake call is made. */
export function createPromoter(client: Client, recover: (candidates: SessionInfo[]) => Promise<string | undefined>, agentID = "ask") {
  let forkID: string | undefined
  let attempted = false
  let before = new Set<string>()
  let operation: Promotion | undefined
  let done = false

  return async (input: Promotion) => {
    const next = Promotion.parse(input)
    if (operation && operation.operationID !== next.operationID) {
      // A successful promotion can be followed by New aside on the same parent.
      if (!done) throw new Error("Finish the previous fork promotion before starting another.")
      forkID = undefined; attempted = false; done = false
    }
    operation = next
    if (done && forkID) return { sessionID: forkID }
    const parent = await client.session.get({ sessionID: input.sessionID })
    const ask = await client.agent.get({ agentID, location: parent.location })
    validateAsk(ask.data)
    const listForks = async () => {
      // Read only this directory's recent root sessions. An ambiguous creation
      // is recovered by explicit selection, never by guessing or re-forking.
      const response = await client.session.list({ directory: parent.location.directory, parentID: null, limit: 100, order: "desc" })
      return response.data.filter((session) => session.fork?.sessionID === input.sessionID)
    }
    if (!forkID && attempted) {
      const candidates = (await listForks()).filter((session) => !before.has(session.id))
      if (!candidates.length) throw new Error("Fork creation could not be confirmed. Check the session picker and connection, then retry Expand to Fork; it will not create a duplicate.")
      forkID = await recover(candidates)
      if (!forkID || !candidates.some((candidate) => candidate.id === forkID)) {
        forkID = undefined
        throw new Error("Select the created fork to finish promotion. The aside is still saved here.")
      }
    }
    if (!forkID) {
      const context = await client.session.context({ sessionID: input.sessionID })
      if (!context.length) throw new Error("Wait for the parent's first completed message before expanding to a fork.")
      before = new Set((await listForks()).map((session) => session.id))
      attempted = true
      try {
        const fork = await client.session.fork({ sessionID: input.sessionID, boundary: { type: "through" } })
        forkID = fork.id
      } catch (error) {
        // A 4xx is a definitive rejection, unlike transport errors or 5xx.
        if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" && error.status >= 400 && error.status < 500) attempted = false
        throw error
      }
    }
    await client.permission.rules({ sessionID: forkID, permissions: [] })
    await client.session.switchAgent({ sessionID: forkID, agent: agentID })
    await client.session.rename({ sessionID: forkID, title: `BTW: ${input.exchanges[0].question.replace(/\s+/g, " ").slice(0, 72)}` })
    // Carry the Q&A as a real, queued USER message (the wrap-it-up primitive):
    // unlike a synthetic, a delivered user message renders as visible chat
    // content, not a description-only notice row. resume:false queues it
    // without waking the fork — zero inference until the user's next message.
    // The deterministic id makes retries idempotent (first admission wins).
    await client.session.prompt({
      sessionID: forkID,
      id: `msg_btw_${input.operationID}`,
      text: transcript(input.exchanges, input.sessionID),
      metadata: { btw: true, operationID: input.operationID, parentID: input.sessionID, exchanges: input.exchanges.length },
      delivery: "steer",
      resume: false,
    })
    done = true
    return { sessionID: forkID }
  }
}
