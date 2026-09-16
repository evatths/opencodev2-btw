import { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { Btw } from "./rpc.ts"
import { createGenerator, loadBuiltinPrompt, normalizeAgentOption, sanitizeAskContext } from "./generate.ts"
import { errorText } from "./aside.ts"

export default Plugin.define({
  id: "opencodev2-btw",
  effect: (ctx) => Effect.gen(function* () {
    const runtime = yield* Effect.context()
    const run = Effect.runPromiseWith(runtime)
    // Bring your own agent: each ask routes through the configured agent
    // (default "ask") when it exists; a missing or unreachable agent falls
    // back to the bundled Ask persona (src/ask.md) as a system prompt —
    // the V2 plugin API cannot register agents. Resolution is per ask, not
    // at setup, so the boot-time agent list race cannot strand a user's
    // real agent behind the fallback.
    const agentID = normalizeAgentOption(ctx.options)
    // The v2.0.3 Promise plugin adapter silently drops RequestOptions, including
    // signal. Run native Effects explicitly so cancellation reaches the model.
    const generator = createGenerator({
      location: ctx.location,
      agentID,
      builtinPrompt: loadBuiltinPrompt(),
      session: {
        get: (input, options) => run(ctx.session.get({ sessionID: Session.ID.make(input.sessionID) }), options),
        generate: (input, options) => run(ctx.session.generate({ sessionID: Session.ID.make(input.sessionID), prompt: input.prompt }), options),
      },
      agent: {
        get: (input, options) => run(ctx.agent.get({ agentID: Agent.ID.make(input.agentID) }), options),
      },
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => generator.dispose()))
    yield* ctx.session.hook("generate", (event) => Effect.sync(() => generator.hook(event)))
    // Ask turns outside session.generate — an Expand-to-Fork's first message, or
    // a session switched to Ask in the ordinary picker — hit Bedrock's toolConfig
    // rejection when inherited history still carries tool-call/tool-result blocks.
    yield* ctx.session.hook("context", (event) => Effect.sync(() => sanitizeAskContext(event, agentID)))
    yield* ctx.rpc.register(Btw, {
      cancel: (input) => Effect.sync(() => generator.cancel(input)),
      ask: (input, context) => Effect.tryPromise({
        try: (signal) => generator.ask(input, signal),
        catch: (error) => {
          const message = errorText(error)
          return context.error("failed", message, { message })
        },
      }),
    })
  }).pipe(Effect.orDie),
})
