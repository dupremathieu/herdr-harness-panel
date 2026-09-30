# harness-panel adapter spec

The panel (herdr split pane) follows the focused herdr agent and asks an **adapter** for a
`PanelSnapshot`. Claude is implemented (`src/adapters/claude.ts`). `codex`, `opencode` and `agy`
are placeholders in `src/adapters/<id>.ts`: **replace only your own file** (plus your fixtures/tests).

## Contract
- `src/model.ts` defines `PanelSnapshot`. **Every field is optional**; omit what your harness cannot
  provide honestly. The UI hides absent sections. Never invent or estimate values.
- `src/adapters/types.ts` defines `Adapter { id; detect(agent); snapshot(ctx) }` and `AgentContext`:
  `{ agent, sessionId?, cwd, paneId?, status? }`, taken from `herdr agent list`
  (`agent`, `agent_session.value`, `cwd`, `pane_id`, `agent_status`).
- Export `const <id>Adapter: Adapter` (already imported in `src/adapters/index.ts`; keep the export name).
- Remove `unsupported: true` once real data is returned.

## Field semantics
| Field | Meaning / unit |
|---|---|
| `model.{name,effort,fast}` | display name, reasoning effort label, fast mode |
| `session.ctxTokens/ctxMax/ctxPct` | tokens currently in context / window size / 0-100 |
| `session.cost` | cumulative session cost in USD; `durationMs` wall time |
| `project.{cwd,branch,worktree}` | reuse `getGitStatus(cwd)` from `src/lib/git` (branch + linked worktree name) |
| `turn.*` | current or last turn = from last real user prompt to now: `tokPerSec` (output tokens / model seconds), `modelMs`, `toolMs` (excluding time waiting on the human), `steps` (model requests), `tokensIn/Out`, `cacheHit` 0-100 (cache-read / total input), `cost` USD |
| `subagents[]` | `{name, status: running|done|error, cost?}` for child agents of this session |
| `mcp` | `total` configured servers; set `up` only if you can truly tell |
| `usage[]` | `{provider, windows:[{label:"5h", pct 0-100, resetsAt: epoch seconds}]}` |

## Rules
1. Read-only. Never write outside your own fixtures; never mutate harness state.
2. Never throw; wrap in try/catch and return whatever you have (`{harness, project:{cwd}}` minimum).
3. Budget < 500 ms per call (called every second): no blocking network, tail large files
   instead of reading them whole, prefer the harness's local API/db over parsing big logs.
4. Identify the session with `ctx.sessionId` first; fall back to the most recent session matching `ctx.cwd`.
5. Keep parsing pure and exported (`parseXxx(text): Partial<PanelSnapshot>`) so it is testable on fixtures.

## Suggested sources (verify on this machine before trusting)
- **codex**: `~/.codex/sessions/YYYY/MM/DD/*.jsonl` (per-session events, token counts), `~/.codex/config.toml` (MCP servers), `~/.codex/models_cache.json`, `logs_2.sqlite`.
- **opencode (v2)**: local server; `opencode api ...` queries the running server (sessions, messages, tokens, cost, child sessions = subagents). MCP in `~/.config/opencode/opencode.jsonc`.
- **agy (Antigravity CLI)**: `~/.gemini/antigravity-cli/{conversations,history.jsonl,log,settings.json}`; formats may be protobuf: best effort, document what is not possible in your adapter header.

## Definition of done
- `src/adapters/<id>.ts` implemented; `__tests__/<id>.test.ts` with a small fixture in `fixtures/<id>/` (sanitised, no secrets or personal content).
- `bun test` passes; `bun src/index.ts --once --harness <id> --session <id> --cwd <dir>` renders sensible sections.
- Header comment lists which fields are supported and which cannot be (and why).
- No changes outside `src/adapters/<id>.ts`, `__tests__/<id>.test.ts`, `fixtures/<id>/`.
