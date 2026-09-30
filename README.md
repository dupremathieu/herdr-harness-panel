# herdr-harness-panel

[![test](https://github.com/dupremathieu/herdr-harness-panel/actions/workflows/test.yml/badge.svg)](https://github.com/dupremathieu/herdr-harness-panel/actions/workflows/test.yml)

A side panel for [herdr](https://herdr.dev) that follows the focused coding agent and shows what
the agent's own UI hides: context usage, turn stats, subagents, MCP servers and usage limits.
It works with several harnesses through small **adapters**: Claude Code, Codex, OpenCode (v2)
and Antigravity CLI (`agy`).

```
claude · Sonnet 5.5
effort high
─────────────────────────────
Session
Context              116.0K · 12%
⣿⣷⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀
Cost                       $1.07
─────────────────────────────
Turn stats
Response             ~48.4 tok/s
Steps                         27
Cache                        98%
─────────────────────────────
Subagents · 2
✓ Review grouped skills menu
MCP · 9
```

Sections appear only when the adapter can provide the data, so each harness shows what is
honestly available (see the table below).

## Requirements
- [herdr](https://herdr.dev) ≥ 0.7.5 (plugin support)
- [Bun](https://bun.sh)
- `git`, `jq` (used by the pane action script)

## Install
```sh
git clone https://github.com/dupremathieu/herdr-harness-panel
herdr plugin link "$PWD/herdr-harness-panel"     # unlink: herdr plugin unlink local.harness-panel
```

Open the panel inside herdr (one panel per tab, idempotent `open`):
```sh
herdr plugin action invoke open   --plugin local.harness-panel
herdr plugin action invoke toggle --plugin local.harness-panel
herdr plugin action invoke close  --plugin local.harness-panel
```
The panel follows the focused agent of its tab. Set `HARNESS_PANEL_SHRINK` (default `0.3`) to
change the panel width.

Render once without herdr, for debugging:
```sh
bun src/index.ts --once --harness claude --session <id> --cwd <dir>
```

### Launch agents with the panel
```sh
_panel() { [ "${HERDR_ENV:-}" = 1 ] && herdr plugin action invoke open --plugin local.harness-panel >/dev/null 2>&1; }
cc()  { _panel; claude "$@"; }
cdx() { _panel; codex "$@"; }
oc()  { _panel; opencode "$@"; }
ag()  { _panel; agy "$@"; }
```

### Claude Code data
Claude Code only hands its live state (model, effort, context, cost, rate limits) to the
`statusLine` command. To let the panel see it, wrap your statusline command with the provided
passthrough, which saves the JSON payload per session and re-emits it:
```json
"statusLine": {
  "type": "command",
  "command": "/path/to/herdr-harness-panel/bin/save-claude-payload.sh | your-statusline-command"
}
```
Without it the panel still shows turn stats, subagents and MCP from the session transcript.

## What each adapter provides
| | Claude | Codex | OpenCode | agy |
|---|---|---|---|---|
| model / effort | ✓ | ✓ | ✓ | ✓ |
| context, cost | ✓ | context | ✓ | – |
| turn stats | ✓ | ✓ | ✓ | steps, timings |
| subagents | ✓ | – | ✓ | ✓ |
| MCP (configured) | ✓ | ✓ | ✓ | ✓ |
| usage limits | 5h / 7d | – | – | – |

Each adapter file documents exactly which fields it supports and why others are impossible.

## Adding a harness
Implement one file in `src/adapters/` and register it in `src/adapters/index.ts`. The contract
(`PanelSnapshot`, rules, definition of done) is in [SPEC.md](SPEC.md).

## Development
```sh
bun test
```

## License
Apache License 2.0, see [LICENSE](LICENSE).
