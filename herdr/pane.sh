#!/usr/bin/env bash
# harness-panel pane actions: open | close | toggle (one panel per tab).
# The panel pane id is remembered in a state file since `plugin pane close` needs it.
set -uo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.bun/bin:${PATH:-}"
H="${HERDR_BIN_PATH:-herdr}"
mode="${1:-toggle}"
ctx="${HERDR_PLUGIN_CONTEXT_JSON:-}"
ctx_field() { [ -n "$ctx" ] && printf '%s' "$ctx" | jq -r ".$1 // empty" 2>/dev/null; }
ws="${HERDR_WORKSPACE_ID:-$(ctx_field workspace_id)}"
tab="${HERDR_TAB_ID:-$(ctx_field tab_id)}"
target="${HERDR_PANE_ID:-$(ctx_field focused_pane_id)}"
[ -n "$ws" ] && [ -n "$tab" ] || { echo "harness-panel: no workspace context (invoke from inside herdr)" >&2; exit 1; }
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/harness-panel"
state="$state_dir/pane-${tab//:/_}"  # one panel per tab
mkdir -p "$state_dir"

is_open() {
  [ -s "$state" ] || return 1
  "$H" pane get "$(cat "$state")" >/dev/null 2>&1
}

open_panel() {
  is_open && return 0
  out=$("$H" plugin pane open --plugin local.harness-panel --entrypoint panel \
    --placement split --direction right --no-focus \
    ${target:+--target-pane "$target"} \
    --env "HERDR_WORKSPACE_ID=$ws" --env "HERDR_TAB_ID=$tab") || { echo "harness-panel: open failed" >&2; exit 1; }
  id=$(printf '%s' "$out" | jq -r '.result.plugin_pane.pane.pane_id // empty' 2>/dev/null)
  [ -n "$id" ] || return 0
  printf '%s' "$id" >"$state"
  # Split opens at 50%; shrink the panel to a sidebar width (best effort).
  "$H" pane resize --pane "$id" --direction right --amount "${HARNESS_PANEL_SHRINK:-0.3}" >/dev/null 2>&1 || :
}

close_panel() {
  is_open && "$H" plugin pane close "$(cat "$state")" >/dev/null 2>&1
  rm -f "$state"
}

case "$mode" in
  open) open_panel ;;
  close) close_panel ;;
  toggle) if is_open; then close_panel; else open_panel; fi ;;
  *) echo "usage: pane.sh open|close|toggle" >&2; exit 2 ;;
esac
