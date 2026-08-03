// ---------------------------------------------------------------------------
// src/main/subscribeTimeout.ts — pure /subscribe server-side timeout math.
//
// Extracted out of commandServer.ts's parseSubscribeRequestBody() so this one
// piece of logic can be unit-tested without pulling in `electron` (that file
// imports `app` near its top, which makes it unimportable from a plain `bun
// run` script — see scripts/verify-tui-layout.ts, which imports THIS file
// directly instead). No other file in this module has any Electron/Node-only
// dependency — keep it that way.
//
// PRIMARY RULE: `timeoutMs === 0` MEANS NO DEADLINE — NEVER `includeTree` ALONE
// -----------------------------------------------------------------------
// An earlier draft of this fix keyed the no-deadline branch off
// `includeTree` (tree-mode subscriptions) alone, unconditionally overriding
// whatever `timeoutMs` the caller sent. That's wrong: it silently discards a
// caller-stated deadline — a future tree subscription that explicitly asked
// for `timeoutMs: 60000` would get turned immortal instead, with the caller
// never told. The correct, caller-honest rule is the literal wire value:
// `body.timeoutMs === 0` (exact numeric zero) is the ONLY thing that means
// "no deadline requested" for a caller who sends a `timeoutMs` at all. This
// closes the actual bug (explicit `0` being indistinguishable from "field
// omitted" under the old `> 0` guard) without ever taking a decision away
// from a caller who states one.
//
// THE TUI CALL SITE ALSO NEEDED A FIX FOR THIS TO MATTER IN PRACTICE
// -----------------------------------------------------------------------
// socket-client.ts's `subscribe(payload, onEvent, opts)` treats `opts.timeoutMs`
// as a CLIENT-side-only value (guards its own local connection-establishment
// setTimeout) — it is NOT automatically included in `payload`, which is what
// actually gets JSON.stringify'd into the request body. So the pre-existing
// TUI call `subscribe({ tree: true }, onEvent, { timeoutMs: 0 })` sent a
// request body of exactly `{"tree":true}` — `body.timeoutMs` was `undefined`
// server-side, not `0`. Both tui/entry.ts and tui-otui/entry.ts were updated
// to also include `timeoutMs: 0` in the PAYLOAD object
// (`subscribe({ tree: true, timeoutMs: 0 }, ...)`) so the explicit-zero rule
// below actually reaches the server for these callers. See those files' own
// comments at the subscribe() call site.
//
// SECONDARY (UX-ONLY) NICETY: omitted `timeoutMs` on a tree-only subscription
// -----------------------------------------------------------------------
// A tree-only subscription (`includeTree: true`, no `workspaceIds`) has
// nothing to resolve — it's a live view, not a wait-for-a-terminal-condition
// request — so if a FUTURE caller opens one without stating any `timeoutMs`
// at all, defaulting it to the 5-minute ws-wait default would be a surprising
// UX regression (a tree view silently dying after 5 minutes with no caller
// intent behind that number). So: omitted timeoutMs + includeTree also
// resolves to the no-deadline ceiling — but this is a DISTINCT, narrower
// branch than the primary rule above, and an explicit positive `timeoutMs`
// from an includeTree caller is still honored (never silently overridden).
// `MAX_CONCURRENT_SUBSCRIPTIONS` (commandServer.ts) remains the real
// protection against a leaked-forever *connection* (bounded fan-out); this
// module only bounds abandoned *duration*.
//
// FULL RESOLUTION TABLE
//   - body.timeoutMs === 0 (any subscription)            → SERVER_NO_DEADLINE_TIMEOUT_MS
//   - body.timeoutMs omitted/non-number/NaN/negative,
//     AND includeTree === true                            → SERVER_NO_DEADLINE_TIMEOUT_MS
//   - body.timeoutMs omitted/non-number/NaN/negative,
//     AND includeTree === false                            → SERVER_DEFAULT_TIMEOUT_MS (5 min)
//   - body.timeoutMs > 0 (any subscription)                → min(timeoutMs, SERVER_MAX_TIMEOUT_MS) (1h cap)
// ---------------------------------------------------------------------------

/** Hard cap for an explicit positive `timeoutMs` value from a /subscribe caller. */
export const SERVER_MAX_TIMEOUT_MS = 60 * 60 * 1000

/** Timeout applied when `timeoutMs` is omitted/invalid on a non-tree subscription. */
export const SERVER_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Timeout applied when "no deadline" is either explicitly requested
 * (`timeoutMs: 0`) or implied (omitted `timeoutMs` on a tree-only
 * subscription) — a large-and-finite ceiling rather than literally
 * unbounded. Not `Infinity`: the real protection against a leaked-forever
 * subscription is `MAX_CONCURRENT_SUBSCRIPTIONS` in commandServer.ts
 * (bounded fan-out, not bounded duration) — this value is a backstop so a
 * genuinely orphaned connection (app crash without a clean socket close,
 * etc) still gets reaped eventually rather than living forever. 24h is long
 * enough that no realistic interactive TUI session (hours of use, laptop
 * sleep, a phone losing signal in a tunnel) ever hits it, short enough that
 * an abandoned connection doesn't accumulate indefinitely.
 */
export const SERVER_NO_DEADLINE_TIMEOUT_MS = 24 * 60 * 60 * 1000

/**
 * Resolve the effective server-side /subscribe timeout from a request body's
 * raw (untrusted, `unknown`-typed) `timeoutMs` field and its `includeTree`
 * flag (`body.tree === true`). Pure function of its inputs — no I/O, no
 * access to request/response objects — so it's directly unit-testable (see
 * scripts/verify-tui-layout.ts). See the file header for the full resolution
 * table and the reasoning for each branch.
 */
export function resolveSubscribeTimeoutMs(rawTimeoutMs: unknown, includeTree: boolean): number {
  // Primary rule: an explicit, literal `0` always means no deadline,
  // regardless of includeTree — never silently overridden by anything else.
  if (rawTimeoutMs === 0) {
    return SERVER_NO_DEADLINE_TIMEOUT_MS
  }
  if (typeof rawTimeoutMs === 'number' && rawTimeoutMs > 0) {
    return Math.min(rawTimeoutMs, SERVER_MAX_TIMEOUT_MS)
  }
  // timeoutMs omitted/non-number/NaN/negative from here on.
  // Secondary nicety: an includeTree subscription with no stated timeoutMs
  // has nothing to resolve, so it defaults to no-deadline too (see file
  // header) — still distinct from, and narrower than, the primary rule.
  if (includeTree) {
    return SERVER_NO_DEADLINE_TIMEOUT_MS
  }
  return SERVER_DEFAULT_TIMEOUT_MS
}
