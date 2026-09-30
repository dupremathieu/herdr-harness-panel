#!/bin/sh
# Claude Code statusLine passthrough: saves the JSON payload for harness-panel, then
# re-emits it so you can chain your own statusline:
#   "statusLine": { "type": "command",
#     "command": "/path/to/harness-panel/bin/save-claude-payload.sh | your-statusline-command" }
# With no downstream command it prints nothing useful, so always chain one (or append `>/dev/null`).
payload=$(cat)
dir="${HARNESS_PANEL_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/harness-panel}/claude"
id=$(printf '%s' "$payload" | sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p' | head -n1)
if [ -n "$id" ]; then
  mkdir -p "$dir" 2>/dev/null && printf '%s' "$payload" >"$dir/$id.json" 2>/dev/null
fi
printf '%s' "$payload"
