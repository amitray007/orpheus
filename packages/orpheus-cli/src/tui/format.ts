/**
 * tui/format.ts — small formatting helpers for the card redesign's
 * right-aligned metadata column (age/activity) and detail pane. Shared by
 * every component under tui/ that needs them (WorkspaceCard, DetailPane).
 *
 * NEW in the card-redesign pass — the previous build never surfaced
 * `lastActivityAt` anywhere in the UI. Ghui's "right-aligned metadata"
 * device (docs/TUI_UI_REDESIGN.md point 5) is the reason this exists: age
 * needs a compact, single-column-width-budget rendering (`16d`, `3h`, `30s`)
 * to sit cleanly right-aligned in a narrow TextTable column.
 */

/** Compact relative age, e.g. "30s", "5m", "3h", "16d". Always <= 4 chars for
 * realistic values so it fits the narrow AGE column budget used at medium+
 * breakpoints. `null`/`undefined` (no activity recorded) renders as "-". */
export function formatAge(epochMs: number | null | undefined, nowMs: number = Date.now()): string {
  if (epochMs == null) return '-'
  const deltaMs = Math.max(0, nowMs - epochMs)
  const seconds = Math.floor(deltaMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

/** Fuller relative-age phrase for the wide detail pane ("30 seconds ago",
 * "16 days ago"), where there's room to spell it out. */
export function formatAgeLong(
  epochMs: number | null | undefined,
  nowMs: number = Date.now()
): string {
  if (epochMs == null) return 'no activity recorded'
  const deltaMs = Math.max(0, nowMs - epochMs)
  const seconds = Math.floor(deltaMs / 1000)
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'} ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * Card redesign's `model effort` line-1 token (docs/TUI_SPEC.md, "AGENT /
 * MODEL / EFFORT" section). Strips a leading `claude-` prefix if present
 * (covers full model ids like `claude-opus-4-8`/`claude-sonnet-5`);
 * otherwise used as-is (covers short aliases the dev DB actually uses
 * today, e.g. `opus`/`sonnet`/`haiku`). No further abbreviation — the task
 * brief is explicit not to guess at rules beyond the `claude-` strip.
 * `effort` is OMITTED entirely when it's `'auto'` (or unset/empty) — per
 * the brief, "auto" tells the user nothing, so it isn't worth a token.
 */
export function formatModelEffort(
  model: string | null | undefined,
  effort: string | null | undefined
): string {
  const modelText = (model ?? '').trim()
  const shortModel = modelText.startsWith('claude-') ? modelText.slice('claude-'.length) : modelText
  const effortText = (effort ?? '').trim()
  const showEffort = effortText.length > 0 && effortText !== 'auto'
  if (shortModel.length === 0) return showEffort ? effortText : ''
  return showEffort ? `${shortModel} ${effortText}` : shortModel
}

/**
 * Card line 1's left (model/effort) + right (status/elapsed) split, already
 * padded so `left.length + right.length === innerWidth` exactly — the two
 * pieces concatenate back to the full padded line with no gap arithmetic at
 * the call site.
 *
 * Status and elapsed are more time-sensitive than the model token, so the
 * LEFT side is what truncates when the line is tight. Lives here rather than
 * beside the card component so BOTH renderers share one implementation and a
 * harness can exercise it without importing a renderer.
 */
export function line1Parts(
  modelEffort: string,
  statusRight: string,
  innerWidth: number,
  truncateFn: (s: string, width: number) => string
): { left: string; right: string } {
  const rightBudget = Math.min(statusRight.length, innerWidth)
  const right = statusRight.slice(statusRight.length - rightBudget)
  const leftBudget = Math.max(0, innerWidth - rightBudget)
  const left = truncateFn(modelEffort, leftBudget).padEnd(leftBudget)
  return { left, right: right.padStart(rightBudget) }
}
