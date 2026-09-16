/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import { generateSyntax } from "@opencode/theme/tui"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createAside, errorText, transcript, type Aside } from "./aside.ts"
import { normalizeAgentOption } from "./generate.ts"
import { Btw } from "./rpc.ts"
import { createPromoter } from "./promote.ts"

const PANEL = "opencodev2-btw"
const MAX_ASIDES = 32

/** Recent questions per session, for prompt recall. */
type History = {
  list(sessionID: string): readonly string[]
  push(sessionID: string, question: string): void
}

function AsidePanel(props: { ctx: Context; panel: PanelInput; aside: Aside; sessionID: string; history: History }) {
  const { ctx, aside } = props
  const [state, setState] = createSignal(aside.get())
  const unsubscribe = aside.subscribe(() => setState(aside.get()))
  // -1 means the draft is the user's own, not a recalled question.
  const [recall, setRecall] = createSignal(-1)
  let editor: TextareaRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  const busy = () => state().status === "generating" || state().status === "expanding"
  const theme = () => ctx.theme
  const syntax = createMemo(() => {
    const style = generateSyntax(theme(), ctx.themeMode)
    onCleanup(() => style.destroy())
    return style
  })
  const model = () => {
    const ref = ctx.data.session.get(props.sessionID)?.model
    return ref ? `${ref.providerID}/${ref.id}` : state().model || "session model"
  }
  createEffect(() => {
    const draft = state().draft
    // The composer unmounts while the panel lives (expansion removes it), so the
    // ref outlives the renderable. OpenTUI's EditBuffer throws on any access
    // after destroy — guard instead of catching, or the slot render "crashes".
    if (editor && !editor.isDestroyed && editor.plainText !== draft) editor.setText(draft)
  })
  onCleanup(() => {
    unsubscribe()
    aside.cancel()
  })
  const close = () => { aside.cancel(); props.panel.close() }
  const expand = async () => {
    const forkID = await aside.expand()
    // A panel render can be disposed before this continuation runs. Navigation
    // belongs to the user's promotion action, not that render instance's lifetime.
    const stillHere = () => {
      const route = ctx.ui.router.current()
      return route.type === "session" && route.sessionID === props.sessionID && ctx.ui.panel.current()?.sessionID === props.sessionID
    }
    if (!forkID || !stillHere()) return
    try {
      await ctx.data.session.sync(forkID)
      await ctx.data.session.pending.sync(forkID)
      if (!stillHere()) return
      // Register the tab before navigation; v2.0.3 focus() only selects a route.
      ctx.ui.tabs.open(forkID)
      ctx.ui.panel.close()
      if (!ctx.ui.tabs.focus(forkID)) ctx.ui.router.navigate({ type: "session", sessionID: forkID })
    } catch (error) {
      ctx.ui.toast.show({ title: "Fork created", message: `Reopen it with Expand to Fork. ${errorText(error)}`, variant: "error" })
    }
  }
  const copy = () => {
    if (!state().exchanges.length) return
    const ok = ctx.renderer.copyToClipboardOSC52(transcript(state().exchanges, props.sessionID))
    ctx.ui.toast.show({ message: ok ? "BTW conversation copied" : "Terminal clipboard is unavailable", variant: ok ? "success" : "error" })
  }
  const submit = () => {
    const question = state().draft.trim()
    // Recall keeps rejected questions too, so an over-long one can be edited.
    if (question) props.history.push(props.sessionID, question)
    setRecall(-1)
    void aside.ask()
  }
  /** Shell-style recall: back from the newest entry, forward to an empty draft. */
  const step = (delta: number) => {
    const questions = props.history.list(props.sessionID)
    if (!questions.length) return
    const index = Math.min(questions.length, Math.max(0, (recall() === -1 ? questions.length : recall()) + delta))
    setRecall(index === questions.length ? -1 : index)
    aside.draft(questions[index] ?? "")
  }
  const location = () => ctx.data.session.get(props.sessionID)?.location ?? ctx.location
  /**
   * The host's own picker (`model.list`) stores a TUI-local preference and only
   * commits it to the session when a prompt is sent, so `session.generate`
   * would keep using the old model. Write the session record directly instead.
   */
  const chooseModel = async () => {
    const origin = location()
    if (!ctx.data.location.model.list(origin)) await ctx.data.location.model.sync(origin)
    const models = (ctx.data.location.model.list(origin) ?? []).filter((entry) => entry.enabled)
    if (!models.length) {
      ctx.ui.toast.show({ message: "No models are available in this location.", variant: "error" })
      return
    }
    const current = ctx.data.session.get(props.sessionID)?.model
    const choice = await ctx.ui.dialog.select({
      title: "Model for this session",
      placeholder: "Search models",
      current: current ? `${current.providerID}/${current.id}` : undefined,
      options: models.map((entry) => ({
        title: entry.name,
        value: `${entry.providerID}/${entry.id}`,
        category: entry.providerID,
        description: entry.status === "active" ? undefined : entry.status,
      })),
    })
    if (!choice) return
    const [providerID, ...rest] = choice.split("/")
    try {
      await ctx.client.session.switchModel({ sessionID: props.sessionID, model: { providerID, id: rest.join("/") } })
      await ctx.data.session.sync(props.sessionID)
    } catch (error) {
      ctx.ui.toast.show({ message: `Could not switch model. ${errorText(error)}`, variant: "error" })
    }
  }
  ctx.keymap.layer(() => ({
    priority: 100,
    enabled: props.panel.focused,
    commands: [
      { id: "btw.close", bind: "escape", run: close },
      { id: "btw.model", bind: "<leader>m", run: () => { void chooseModel() } },
      { id: "btw.history.previous", bind: "up", enabled: () => !busy() && (!state().draft || recall() !== -1), run: () => step(-1) },
      { id: "btw.history.next", bind: "down", enabled: () => !busy() && recall() !== -1, run: () => step(1) },
      { id: "btw.fullscreen", bind: "ctrl+f", run: props.panel.toggleFullscreen },
      { id: "btw.expand", bind: "ctrl+e", run: () => { void expand() } },
      { id: "btw.copy", bind: "ctrl+y", run: copy },
      { id: "btw.new", bind: "ctrl+n", run: () => aside.reset() },
      { id: "btw.scroll.up", bind: "pageup", run: () => { if (scroll && !scroll.isDestroyed) scroll.scrollBy(-(scroll.height || 10)) } },
      { id: "btw.scroll.down", bind: "pagedown", run: () => { if (scroll && !scroll.isDestroyed) scroll.scrollBy(scroll.height || 10) } },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} height="100%" paddingX={1} gap={1} onMouseDown={props.panel.focus}>
      <box flexDirection="column" flexShrink={0}>
        <text fg={theme().text.default}><b>Ask</b> · BTW</text>
        <text fg={theme().text.subdued}>Current completed context · {model()}</text>
        <text fg={theme().text.subdued}>Ephemeral · parent keeps working · model follows the session</text>
      </box>
      <scrollbox ref={scroll} flexGrow={1} minHeight={1} scrollX={false} stickyScroll stickyStart="bottom" contentOptions={{ gap: 1 }}>
        <Show when={state().exchanges.length} fallback={<text fg={theme().text.subdued}>Ask about this conversation. Follow-ups also see newly completed parent context.</text>}>
          <For each={state().exchanges}>{(exchange) => (
            <box flexDirection="column" gap={1} flexShrink={0}>
              <text fg={theme().text.default}><b>You</b>  {exchange.question}</text>
              <box flexDirection="column" flexShrink={0}>
                <text fg={theme().text.subdued}><b>Ask</b></text>
                <markdown content={exchange.answer} syntaxStyle={syntax()} fg={theme().text.default} conceal streaming={false} />
              </box>
            </box>
          )}</For>
        </Show>
        <Show when={state().status === "generating"}>
          <text fg={theme().text.status.running}>Asking…  Esc cancels this request</text>
        </Show>
        <Show when={state().status === "expanding"}>
          <text fg={theme().text.status.running}>Creating fork and carrying over the conversation…</text>
        </Show>
      </scrollbox>
      <Show when={state().error}>
        <text flexShrink={0} fg={theme().text.feedback.error.default}>{state().error}</text>
      </Show>
      <Show when={state().forkID}>
        <text fg={theme().text.subdued}>Fork ready. Expand to Fork opens it; New aside starts fresh.</text>
      </Show>
      <Show when={!state().promotionID}>
        <box border borderColor={theme().border.default} flexShrink={0}>
          <textarea
            ref={editor}
            initialValue={state().draft}
            minHeight={2}
            maxHeight={6}
            flexGrow={1}
            focused={props.panel.focused && !busy()}
            placeholder="Ask a question…"
            textColor={theme().text.default}
            backgroundColor={theme().background.default}
            focusedBackgroundColor={theme().background.default}
            keyBindings={[{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" }]}
            onContentChange={() => {
              if (!editor) return
              const text = editor.plainText
              // Editing a recalled question makes it the user's own draft again.
              if (recall() !== -1 && text !== props.history.list(props.sessionID)[recall()]) setRecall(-1)
              aside.draft(text)
            }}
            onSubmit={submit}
          />
        </box>
      </Show>
      <box flexDirection="row" flexWrap="wrap" columnGap={2} flexShrink={0}>
        <text fg={theme().text.subdued} onMouseDown={() => { if (!busy()) submit() }}>Enter Ask</text>
        <text fg={theme().text.subdued} onMouseDown={props.panel.toggleFullscreen}>^F {props.panel.presentation === "fullscreen" ? "Side panel" : "Fullscreen"}</text>
        <text fg={!busy() && state().exchanges.length ? theme().text.default : theme().text.subdued} onMouseDown={() => { void expand() }}>^E Expand to Fork</text>
        <Show when={ctx.keymap.shortcuts("btw.model")[0]} fallback={<text fg={theme().text.subdued} onMouseDown={() => { void chooseModel() }}>Model</text>}>{(key) => (
          <text fg={theme().text.subdued} onMouseDown={() => { void chooseModel() }}>{key()} Model</text>
        )}</Show>
        <text fg={theme().text.subdued} onMouseDown={copy}>^Y Copy</text>
        <text fg={theme().text.subdued} onMouseDown={() => aside.reset()}>^N New aside</text>
        <text fg={theme().text.subdued} onMouseDown={close}>Esc Close</text>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "opencodev2-btw.tui",
  setup(ctx) {
    const rpc = ctx.client.rpc(Btw)
    const asides = new Map<string, Aside>()
    // Ephemeral like the asides themselves: survives hot reload, not TUI exit.
    const [recent, remember] = ctx.storage.memory<{ questions: Record<string, string[]> }>("btw.history", { initial: { questions: {} } })
    const history: History = {
      list: (sessionID) => recent.questions[sessionID] ?? [],
      push: (sessionID, question) => remember((draft) => {
        const questions = (draft.questions[sessionID] ??= [])
        if (questions.at(-1) === question) return
        questions.push(question)
        if (questions.length > 50) questions.shift()
      }),
    }
    function getAside(sessionID: string) {
      let aside = asides.get(sessionID)
      if (aside) return aside
      if (asides.size >= MAX_ASIDES) {
        const empty = [...asides].find(([, a]) => !a.get().exchanges.length && !a.get().draft && a.get().status === "editing")
        if (empty) asides.delete(empty[0])
        else throw new Error("32 asides are open. Use New aside in an old thread to free space.")
      }
      // Resolve the originating session's location on every request, including after a move.
      const location = () => ctx.data.session.get(sessionID)?.location ?? ctx.location ?? ctx.data.location.default()
      aside = createAside(sessionID, {
        ask: async (input, signal) => {
          const origin = location()
          await ctx.client.plugin.awaitActivation({ location: origin }, { signal })
          signal.throwIfAborted()
          const requestID = crypto.randomUUID()
          // V2's RPC handler survives a disconnected HTTP caller. Cancel the
          // plugin-owned generation explicitly, never the parent session.
          const cancel = () => { void rpc.cancel({ sessionID, requestID }, { location: origin }).catch(() => {}) }
          signal.addEventListener("abort", cancel, { once: true })
          try {
            return await rpc.ask({ ...input, requestID }, { signal, location: origin })
          } finally {
            signal.removeEventListener("abort", cancel)
          }
        },
        expand: createPromoter(ctx.client, (candidates) => ctx.ui.dialog.select({
          title: "Recover the created BTW fork",
          options: candidates.map((session) => ({ title: session.title ?? session.id, value: session.id, description: new Date(session.time.created).toLocaleString() })),
        }), normalizeAgentOption(ctx.options)),
      })
      asides.set(sessionID, aside)
      return aside
    }
    // setup runs outside Keymap.Provider in v2.0.3. The app slot owns this
    // registration so slash/palette commands have the host's input context.
    const unregisterCommands = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "btw.open", title: "Ask a side question", group: "BTW", palette: true,
            slash: { name: "btw", arguments: true },
            enabled: () => ctx.ui.router.current().type === "session",
            run: (question) => {
              const route = ctx.ui.router.current()
              if (route.type !== "session") return
              try {
                const aside = getAside(route.sessionID)
                if (question?.trim()) {
                  if (aside.get().status !== "editing" || aside.get().promotionID) {
                    ctx.ui.toast.show({ message: "Finish the current request or choose New aside first.", variant: "info" })
                  } else {
                    history.push(route.sessionID, question.trim())
                    aside.draft(question)
                    void aside.ask()
                  }
                }
                ctx.ui.panel.open(PANEL)
              } catch (error) {
                ctx.ui.toast.show({ message: errorText(error), variant: "error" })
              }
            },
          }],
        }))
        return null
      },
    })
    const unregister = ctx.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <Show when={panel.sessionID} keyed>{(id) => <AsidePanel ctx={ctx} panel={panel} sessionID={id} aside={getAside(id)} history={history} />}</Show>
        </Show>
      ),
    })
    const unregisterCarryover = ctx.ui.slot({
      append: "session.composer.top",
      render: ({ sessionID }) => {
        const imported = () => ctx.data.session.pending.list(sessionID).find((item) => item.type === "user" && item.payload.metadata?.btw === true)
        return <Show when={imported()}>{(item) => (
          <text fg={ctx.theme.text.subdued} onMouseDown={() => {
            const entry = item()
            if (entry.type !== "user") return
            ctx.ui.dialog.set({ size: "large" })
            ctx.ui.dialog.show(() => <box padding={1} height={24}><scrollbox><text>{entry.payload.text}</text></scrollbox></box>)
          }}>BTW conversation saved above · joins context on your next message</text>
        )}</Show>
      },
    })
    return () => { unregisterCommands(); unregister(); unregisterCarryover(); for (const aside of asides.values()) aside.cancel(); asides.clear() }
  },
})
