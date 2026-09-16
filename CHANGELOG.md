# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-15

### Added

- `/btw` command that opens an **Ask** side panel beside the working session; questions see the parent session's latest completed context
- Ephemeral generation — answers never modify the parent session's history, agent, permissions, or inbox
- Shell-style ↑/↓ prompt recall (per-session history, lasting until the TUI exits)
- `<leader>m` model picker while the panel is focused
- Ctrl+F fullscreen toggle
- **Expand to Fork** (Ctrl+E): promotes the aside into a real forked session, carrying the completed Q&A as a visible queued user message — with zero model calls
- Zero-tools requests with tool-history flattening, working around the Bedrock Converse API rejection when the parent session contains tool calls
- `agent` option to bring your own configured agent as the side-panel persona, with a bundled built-in Ask prompt as fallback (zero configuration required)
- Shell-style keybindings: Ctrl+Y copy, Ctrl+N new aside, Esc close, Page Up/Down scroll

### Notes

- Initial release, extracted from a personal setup for community distribution.
