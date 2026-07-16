// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/TokenHoverPopover.tsx
//
// Pierre adoption Batch 3 — token hover: hovering a syntax token in either
// diff viewer (GitTab's <PatchDiff>, FilesTab's <PierreFile>) shows a small
// dark tooltip anchored to the hovered token — its text, "line:col" position,
// and a Copy button. Scope is deliberately small (per the task brief): no
// LSP/symbol lookup, just token text + position + copy.
//
// The controller hook (`useTokenHoverPopover`) lives in its own file,
// useTokenHoverPopover.ts — this repo's `react-refresh/only-export-
// components` lint rule requires a component file to export ONLY
// components, so co-locating a hook here would break Fast Refresh.
//
// Positioning: `position: fixed` using the hovered token's own
// getBoundingClientRect() — no portal needed (unlike Overlay.tsx's
// menu/dialog convention, which is positioning-agnostic and left to the
// caller's own className/style). A fixed-position div with a high z-index
// paints above the diff pane's own scroll container without needing to
// escape any overflow:hidden ancestor, so createPortal buys nothing here.
//
// Dismiss timing (owned by the hook, see its own doc comment): shows
// immediately on `onTokenEnter`, hides ~180ms after `onTokenLeave` unless
// cancelled — this component's own onMouseEnter/onMouseLeave (wired by the
// caller to the hook's cancelHide/scheduleHide) is what lets the user move
// the pointer from the token onto this popover's Copy button without it
// vanishing mid-move.
// ---------------------------------------------------------------------------

import type React from 'react'
import { useEffect, useState } from 'react'
import { Copy, Check } from '@phosphor-icons/react'
import type { TokenHoverState } from './useTokenHoverPopover'
import './TokenHoverPopover.css'

/** Very long tokens (a minified identifier, a long string literal) are
 *  truncated in the popover's own text row — the full value is still
 *  available via the row's `title` attribute and via Copy. */
const MAX_DISPLAY_LENGTH = 160

export interface TokenHoverPopoverProps {
  state: TokenHoverState | null
  onMouseEnter: () => void
  onMouseLeave: () => void
}

/** Thin wrapper: renders nothing while `state` is null, otherwise mounts
 *  `TokenHoverCard` KEYED on the hovered token's text. Keying it this way is
 *  what resets the card's own "Copied" confirmation state when the hovered
 *  token changes — React tears down and remounts a fresh instance rather
 *  than this component reaching for a ref/effect to detect the change (both
 *  ref writes and setState calls are disallowed during render by this
 *  repo's react-hooks lint config). */
export function TokenHoverPopover({
  state,
  onMouseEnter,
  onMouseLeave
}: TokenHoverPopoverProps): React.JSX.Element | null {
  if (state === null) return null
  return (
    <TokenHoverCard
      key={state.tokenText}
      state={state}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    />
  )
}

/** The floating card itself — a fresh instance per distinct hovered token
 *  (see the wrapper's own doc comment above), so `copied` always starts
 *  false for a newly-hovered token without needing an effect to reset it. */
function TokenHoverCard({
  state,
  onMouseEnter,
  onMouseLeave
}: {
  state: TokenHoverState
  onMouseEnter: () => void
  onMouseLeave: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(id)
  }, [copied])

  const tokenText = state.tokenText
  const truncated =
    tokenText.length > MAX_DISPLAY_LENGTH ? `${tokenText.slice(0, MAX_DISPLAY_LENGTH)}…` : tokenText

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(tokenText)
      setCopied(true)
    } catch (err) {
      console.error('[TokenHoverPopover] clipboard copy failed:', err)
    }
  }

  return (
    <div
      className="tok-hover-popover"
      style={{
        top: state.rect.bottom + 4,
        left: state.rect.left
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span className="tok-hover-text" title={tokenText}>
        {truncated}
      </span>
      <div className="tok-hover-footer">
        <span className="tok-hover-pos">
          {state.line}:{state.col}
        </span>
        <button
          type="button"
          className="tok-hover-copy"
          onClick={() => void handleCopy()}
          aria-label={copied ? 'Copied token text' : 'Copy token text'}
          title={copied ? 'Copied' : 'Copy'}
        >
          {copied ? (
            <Check size={11} weight="bold" className="text-emerald-400" />
          ) : (
            <Copy size={11} weight="bold" />
          )}
        </button>
      </div>
    </div>
  )
}
