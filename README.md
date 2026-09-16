# BTW

Ask quick clarifying questions in a side panel — without derailing your session. BTW ("by the way") opens an **Ask** panel beside your working OpenCode session, so you can poke at context, check an assumption, or think out loud while your main session keeps running untouched.

## How it works

Run `/btw <question>` (or `/btw` to reopen the panel) and BTW opens an **Ask** side panel next to your session. Each question sees the parent session's latest **completed** context plus the earlier local exchanges; queued inputs and unfinished tool work aren't visible. Answers are generated ephemerally — the parent session, its agent, permissions, inbox, and history are never modified.

When a side question turns into something worth acting on, **Expand to Fork** promotes the aside into a real, independently forked session. The completed Q&A is carried over as a visible queued user message (rendered as markdown in the fork's transcript), ready to continue the conversation — and promotion makes **zero model calls**.

## Install

Requires OpenCode v2 (>= 2.0.3).

From npm:

```sh
opencode plugin add opencodev2-btw
```

Or directly from GitHub:

```sh
opencode plugin add github:evatths/opencodev2-btw
```

Then reopen the TUI. Check **Plugins** in the command palette to confirm the plugin loaded.

## Configuration

Add the plugin to your `opencode.json` to configure it:

```jsonc
{
  "plugins": [
    {
      "package": "opencodev2-btw",
      "options": {
        "agent": "ask"
      }
    }
  ]
}
```

### Options

| Option  | Type     | Default | Description                                                                                       |
| ------- | -------- | ------- | ------------------------------------------------------------------------------------------------- |
| `agent` | `string` | —       | Name of one of **your own configured agents** to use as the persona for side questions. Optional. |

### Bring your own agent

The `agent` option names an agent **you** have already defined in your OpenCode config. If an agent with that name exists, BTW uses it — its prompt, its tone, its model preferences — as the persona for the Ask panel.

If the named agent doesn't exist (or you don't configure the option at all), BTW falls back to a **bundled built-in Ask prompt**. Zero configuration is required: install the plugin and `/btw` just works.

## Features

- **`/btw` side panel** — opens an Ask panel beside the working session; questions see the parent's latest completed context
- **Ephemeral generation** — answers never touch the parent session's history, agent, or permissions
- **Shell-style prompt recall** — ↑/↓ recalls previous questions when the input is empty; history is per session
- **Model picker** — `<leader>m` picks the model, using the same key as the host's picker while the panel is focused
- **Fullscreen toggle** — Ctrl+F changes presentation only
- **Expand to Fork** — Ctrl+E promotes the aside into a real forked session, carrying the Q&A as a visible queued user message
- **Zero-tools requests with tool-history flattening** — works around a Bedrock Converse API rejection (`The toolConfig field must be defined when using toolUse and toolResult content blocks.`) when the parent session contains tool calls
- **Copy / new aside / close** — Ctrl+Y, Ctrl+N, Esc; Page Up/Down scrolls the answer; action labels are clickable

## Requirements

- OpenCode **v2** (>= 2.0.3)
- Node.js >= 22 (the package ships TypeScript sources directly — there is no build step, per the OpenCode plugin publish convention)

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --experimental-strip-types --test tests/*.test.mts
```

## License

[Apache-2.0](./LICENSE) © 2026 Evatt Harvey-Salinger
