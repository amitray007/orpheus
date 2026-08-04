/**
 * tui/reconnect.ts — pure backoff-schedule helper for the Ink TUI, used by
 * tui/entry.ts.
 *
 * WHY RECONNECT EXISTS AT ALL (see docs/TUI_SPEC.md D5, and Layer 1 of this
 * fix in src/main/subscribeTimeout.ts): even with the server no longer
 * killing a tree-mode subscription at 300s, a stream can still end for
 * reasons outside anyone's control — the Orpheus app restarting, a laptop
 * sleeping, a phone's connection dropping in a tunnel (the whole premise of
 * the phone-via-Termius use case this feature targets). Before this fix,
 * ANY unexpected stream end sent the TUI straight back to a shell prompt.
 * Both entry.ts files now attempt to resubscribe with backoff instead of
 * giving up immediately.
 */

/** Base delay for the first reconnect attempt, before any exponential growth. */
const BASE_DELAY_MS = 500

/** Hard ceiling on the backoff delay, regardless of how many attempts have failed. */
const MAX_DELAY_MS = 30_000

/**
 * Floor on the returned delay. Pure full-jitter (`random() * cappedExponential`)
 * can land arbitrarily close to 0ms — fine for thundering-herd avoidance in
 * the general case, but for THIS caller (a single interactive TUI retrying
 * against one app instance, not a fleet of independent clients) a near-zero
 * delay on a still-down server means the "Reconnecting… (attempt N)" notice
 * and the next failed attempt's re-render can land within the same terminal
 * frame, which reads as UI flicker/strobing rather than a calm retry
 * indicator. A small floor guarantees the notice is visible for at least
 * this long before the next attempt fires, without meaningfully slowing down
 * recovery once the server IS back (200ms is imperceptible as "slow").
 */
const MIN_DELAY_MS = 200

/**
 * Compute the backoff delay (in ms) before reconnect attempt number `attempt`
 * (1-indexed: `attempt=1` is the delay before the FIRST reconnect try, after
 * the initial unexpected disconnect — callers may choose to skip this delay
 * entirely for attempt 1 and only start applying it from attempt 2 onward;
 * see each entry.ts's call site for which it chose).
 *
 * Formula: full-jitter exponential backoff, floored — `max(MIN_DELAY_MS,
 * random() * min(MAX_DELAY_MS, BASE_DELAY_MS * 2^(attempt-1)))`. Doubling per
 * attempt starting from a 500ms base, hard-capped at 30s so a long outage
 * settles into retrying roughly every 15s on average (half of the 30s cap,
 * full-jitter's expected value) rather than growing unboundedly. Full jitter
 * (multiplying the capped exponential by a random value in [0, 1), not
 * adding a smaller jitter on top of a fixed delay) avoids every retry
 * landing in lockstep if multiple TUI sessions happen to be reconnecting at
 * once against the same app instance (thundering-herd avoidance — standard
 * "Full Jitter" from the AWS Architecture Blog's backoff-and-jitter
 * writeup); the MIN_DELAY_MS floor on top avoids the UI-flicker failure mode
 * described in that constant's own doc comment.
 *
 * Pure function of `attempt` (plus an injectable `random` source so this is
 * deterministically unit-testable without mocking global Math.random or
 * real timers — see scripts/verify-tui-layout.ts).
 *
 * `attempt` is clamped to >= 1 (an `attempt <= 0` is treated as 1) so a
 * caller can't accidentally request a negative/zero exponent.
 */
export function nextBackoffMs(attempt: number, random: () => number = Math.random): number {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  const cappedExponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (safeAttempt - 1))
  return Math.max(MIN_DELAY_MS, random() * cappedExponential)
}
