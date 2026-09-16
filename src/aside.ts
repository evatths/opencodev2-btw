import { MAX_EXCHANGES, MAX_QUESTION, MAX_TRANSCRIPT, type Exchange, type Promotion, type Question } from "./rpc.ts"

export function transcript(exchanges: readonly Exchange[], parentSessionID?: string): string {
  return [
    "Carried from a BTW aside — already answered; historical context only; don't re-answer or elaborate unprompted.",
    ...(parentSessionID
      ? [`This is a fork of session \`${parentSessionID}\`; that session is likely still running, and its context may have advanced since these answers.`]
      : []),
    "",
    ...exchanges.flatMap(({ question, answer, time }) => [
      `**Me — ${new Date(time).toLocaleString()}**`,
      question,
      "",
      "**Ask**",
      answer,
      "",
    ]),
  ].join("\n")
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message)
  return String(error)
}

export interface AsidePorts {
  ask(input: Question, signal: AbortSignal): Promise<{ text: string; model: string }>
  expand(input: Promotion): Promise<{ sessionID: string }>
}

/** Client-lifetime state only. In-flight identity survives UI close/reopen races. */
export function createAside(sessionID: string, ports: AsidePorts) {
  let state = {
    draft: "",
    exchanges: [] as Exchange[],
    status: "editing" as "editing" | "generating" | "expanding" | "expanded",
    error: "",
    model: "",
    forkID: "",
    promotionID: "",
  }
  let generation: AbortController | undefined
  const listeners = new Set<() => void>()
  const update = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  return {
    get: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    draft(text: string) { update({ draft: text }) },
    cancel() {
      generation?.abort()
      generation = undefined
      if (state.status === "generating") update({ status: "editing" })
    },
    async ask() {
      if (state.status !== "editing" || state.promotionID) return
      const question = state.draft.trim()
      if (!question) return
      if (question.length > MAX_QUESTION) {
        update({ error: `Keep the question under ${MAX_QUESTION.toLocaleString()} characters.` })
        return
      }
      if (state.exchanges.length >= MAX_EXCHANGES || state.exchanges.reduce((n, e) => n + e.question.length + e.answer.length, 0) > MAX_TRANSCRIPT - 128_000 - MAX_QUESTION) {
        update({ error: "This aside is full. Use Expand to Fork or New aside." })
        return
      }
      const request = new AbortController()
      generation = request
      update({ status: "generating", error: "" })
      try {
        const answer = await ports.ask({ sessionID, question, exchanges: state.exchanges }, request.signal)
        if (generation !== request || request.signal.aborted) return
        if (!answer.text.trim()) throw new Error("Ask returned no text. Your question is saved; press Enter to retry.")
        update({
          exchanges: [...state.exchanges, { question, answer: answer.text, time: Date.now() }],
          draft: "", model: answer.model,
        })
      } catch (error) {
        if (generation === request && !request.signal.aborted) update({ error: errorText(error) })
      } finally {
        if (generation === request) {
          generation = undefined
          update({ status: "editing" })
        }
      }
    },
    async expand(): Promise<string | undefined> {
      if (state.forkID) return state.forkID
      if (state.status !== "editing" || !state.exchanges.length) return
      // Reuse the operation on retry, including an ambiguous HTTP response.
      update({ status: "expanding", error: "", promotionID: state.promotionID || crypto.randomUUID() })
      try {
        const result = await ports.expand({ sessionID, operationID: state.promotionID, exchanges: state.exchanges })
        update({ forkID: result.sessionID, status: "expanded" })
        return result.sessionID
      } catch (error) {
        update({ status: "editing", error: errorText(error) })
      }
    },
    reset() {
      // Promotion can have committed even when its HTTP response was lost.
      if (state.status === "expanding" || (state.promotionID && !state.forkID)) return
      this.cancel()
      update({ draft: "", exchanges: [], status: "editing", error: "", model: "", forkID: "", promotionID: "" })
    },
  }
}

export type Aside = ReturnType<typeof createAside>
