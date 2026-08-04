/**
 * tui/addProjectLayout.ts — pure text-buffer + width-computation helpers for
 * the `p` (add project) overlay (components/AddProjectPrompt.tsx).
 *
 * WHY THIS IS ITS OWN FILE, NOT INLINE IN THE COMPONENT
 * -----------------------------------------------------------------------
 * Mirrors wizardLayout.ts's own rationale (see that file's header): nothing
 * here imports react/ink, so scripts/verify-tui-wizard.ts can exercise the
 * exact buffer/width math a phone-portrait Termius session (~38 columns)
 * will hit without mounting a component or opening a socket.
 *
 * WHY A HAND-ROLLED BUFFER, NOT A LIBRARY
 * -----------------------------------------------------------------------
 * Same reasoning the (since-removed, see commit d5ceebe5) wizard name-entry
 * step used: orpheus-cli has zero UI-library dependencies today, and a
 * cursor-position + backspace + printable-insertion buffer is small enough
 * that adding ink-text-input for one field isn't worth the first dependency
 * this package would take on. Unlike that removed step (a workspace name
 * immediately overwritten by Claude's terminal title — see wizardTypes.ts's
 * header), a filesystem path has no such auto-populated alternative: it must
 * be typed, so this buffer earns its keep.
 *
 * WHY THE FIELD SCROLLS RATHER THAN JUST END-TRUNCATING
 * -----------------------------------------------------------------------
 * A path can easily exceed the ~35-column budget available at phone width
 * (e.g. `~/code/projects/some-very-deeply-nested-monorepo/packages/app`).
 * End-truncating (like `truncate()` in layout.ts) would permanently hide
 * whatever the user is currently editing once the buffer grows past the
 * field width — they'd be typing "blind" past the visible window with no
 * way to see the cursor or the characters immediately around it. Instead
 * this behaves like a real single-line text input: the visible window
 * SCROLLS to always keep the cursor in view, computed fresh from
 * (value, cursorPos, innerWidth) on every render — no stateful "scroll
 * offset" to keep in sync with the buffer, so a jump (e.g. pressing Home/
 * End-equivalent) can never desync the two.
 */

export const PATH_FIELD_GUTTER_COLUMNS = 2
export const PATH_FIELD_PAD_RIGHT = 1

/**
 * Full width available for the path field's TEXT content (after the gutter
 * and trailing pad are carved out) — mirrors wizardLayout.ts's
 * listRowInnerWidth exactly (same constants' role, different names since
 * this field has no list-row suffix concern). Floors at 1 so a
 * pathologically narrow terminal never produces a non-positive width.
 */
export function pathFieldInnerWidth(contentWidth: number): number {
  return Math.max(1, contentWidth - PATH_FIELD_GUTTER_COLUMNS - PATH_FIELD_PAD_RIGHT)
}

export interface PathFieldWindow {
  /** The visible slice of `value`, exactly `innerWidth` characters (padded
   *  with trailing spaces when the value is shorter than the field). */
  text: string
  /** Index into `text` (not into the original `value`) where the cursor
   *  should render — always within [0, innerWidth]. */
  cursorColumn: number
}

/**
 * Compute the scrolled, padded visible window of `value` for a field of
 * `innerWidth` columns, keeping `cursorPos` (an index into `value`, in
 * [0, value.length]) always in view.
 *
 * Windowing rule: if the whole value already fits, show it from column 0
 * (no scrolling) and pad to innerWidth. Otherwise scroll the minimum amount
 * needed to keep the cursor visible — mirrors a standard terminal line
 * editor: scrolling left when the cursor would fall before the window,
 * right when it would fall past the last visible column (innerWidth - 1,
 * since the cursor can also sit one-past-the-end to allow appending).
 *
 * Always returns a `text` of EXACTLY `innerWidth` characters (pad THEN
 * color discipline — see CloseArchiveConfirm.tsx's header — even though
 * this field doesn't currently apply a background tint, matching the
 * convention every other fixed-width row in this TUI follows) and a
 * `cursorColumn` guaranteed to be within [0, innerWidth].
 */
export function buildPathFieldWindow(
  value: string,
  cursorPos: number,
  innerWidth: number
): PathFieldWindow {
  const clampedCursor = Math.max(0, Math.min(cursorPos, value.length))

  if (value.length <= innerWidth) {
    return { text: value.padEnd(innerWidth), cursorColumn: clampedCursor }
  }

  // Value overflows the field — compute a scroll offset that keeps the
  // cursor in view. maxStart caps scrolling once the tail of the value
  // fills the field exactly (never scroll past the point where trailing
  // blank columns would appear before the value is actually exhausted).
  const maxStart = value.length - innerWidth
  let start = 0
  if (clampedCursor > innerWidth - 1) {
    // Cursor would fall past the last visible column — scroll right just
    // enough to bring it to the field's last column.
    start = Math.min(maxStart, clampedCursor - (innerWidth - 1))
  }
  // (No separate "scroll left" branch is needed: start begins at 0, and the
  // only way clampedCursor could be before an already-nonzero start is if a
  // caller moved the cursor backward — but this function recomputes `start`
  // from scratch every call rather than carrying state forward, so a
  // backward cursor move naturally re-resolves start back toward 0 via the
  // same branch above evaluating false and leaving start at its initial 0.)

  const end = start + innerWidth
  return {
    text: value.slice(start, end).padEnd(innerWidth),
    cursorColumn: clampedCursor - start
  }
}

// ---------------------------------------------------------------------------
// Buffer mutation — pure functions, no React state. Mirrors the removed
// NameStep's handleNameKey logic (wizardStepMachine.ts, commit d5ceebe5^)
// almost exactly: same cursor-clamping/backspace/insertion shape, extracted
// here as standalone functions (rather than folded into a single
// key-dispatch function) so scripts/verify-tui-wizard.ts can assert each
// operation's boundary behavior (position 0, end-of-string) in isolation.
// ---------------------------------------------------------------------------

export interface PathBuffer {
  value: string
  cursorPos: number
}

/** Move the cursor left/right by `delta`, clamped to [0, value.length]. */
export function moveCursor(buffer: PathBuffer, delta: number): PathBuffer {
  const next = Math.max(0, Math.min(buffer.value.length, buffer.cursorPos + delta))
  return next === buffer.cursorPos ? buffer : { ...buffer, cursorPos: next }
}

/**
 * Delete the character immediately before the cursor (standard backspace).
 * No-op at position 0 — returns the same buffer reference so callers can
 * cheaply skip a re-render when nothing changed.
 */
export function backspace(buffer: PathBuffer): PathBuffer {
  if (buffer.cursorPos === 0) return buffer
  const value = buffer.value.slice(0, buffer.cursorPos - 1) + buffer.value.slice(buffer.cursorPos)
  return { value, cursorPos: buffer.cursorPos - 1 }
}

/**
 * Insert printable text at the cursor position, advancing the cursor past
 * the inserted text. `input` is typically a single character (Ink reports
 * one keypress at a time), but this accepts any length so a future paste
 * path (if Ink ever exposes one) works without changes here.
 */
export function insertText(buffer: PathBuffer, input: string): PathBuffer {
  if (input.length === 0) return buffer
  const value =
    buffer.value.slice(0, buffer.cursorPos) + input + buffer.value.slice(buffer.cursorPos)
  return { value, cursorPos: buffer.cursorPos + input.length }
}
