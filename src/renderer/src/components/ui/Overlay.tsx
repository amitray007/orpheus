import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useFocusOnMount } from '@/lib/useFocusOnMount'

// Stable "nothing to focus" ref reused across renders when dialog mode is
// off, so useFocusOnMount's effect (keyed on the ref identity) doesn't
// re-run on every render of non-dialog Overlay usages.
const NULL_REF: RefObject<HTMLElement | null> = { current: null }

interface OverlayProps {
  open: boolean
  onDismiss?: () => void
  interactive?: boolean
  portal?: boolean
  className?: string
  style?: React.CSSProperties
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  /**
   * Opt-in modal-dialog semantics: `role="dialog"` + `aria-modal="true"`,
   * initial focus on mount, a Tab/Shift+Tab focus trap cycling within the
   * overlay, and focus restoration to the previously-active element on
   * unmount. Off by default because most Overlay usages are menus/popovers/
   * listboxes (ContextMenu, Select, SplitButton, NewWorkspaceMenu, ...) that
   * must NOT claim dialog semantics. Set true for true modal dialogs
   * (ConfirmModal and similar).
   */
  dialog?: boolean
  children: React.ReactNode
}

// Selector for elements a focus trap should cycle between — standard
// interactive-element allowlist, excluding disabled/hidden-via-tabindex nodes.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

// The single sanctioned way to paint DOM over the terminal IN-WINDOW. Optionally
// portals to body; and — when interactive — owns Escape + outside-click so
// overlays stop attaching their own focus-stealing document listeners.
// POSITIONING-AGNOSTIC: callers keep their own coordinate math via
// className/style or by rendering in place (portal={false}).
//
// NOTE: a same-window DOM node can never paint above the terminal's NSView
// (see docs/learnings/overlay-child-window-macos.md) — this component doesn't
// change that. UI that must render above the live terminal uses the
// child-window overlay layer (overlayClient.ts), a separate window/NSView
// sibling, not this component. Use Overlay for DOM chrome that's fine being
// occluded by the terminal (e.g. content within non-terminal views).
export function Overlay({
  open,
  onDismiss,
  interactive = false,
  portal = false,
  className,
  style,
  onMouseEnter,
  onMouseLeave,
  dialog = false,
  children
}: OverlayProps): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || !interactive || !onDismiss) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, interactive, onDismiss])

  // Initial focus — the container itself when dialog mode is on (a plain
  // useFocusOnMount(ref) call, same contract as every other consumer of that
  // hook). Focusing the container (not the first focusable child) mirrors
  // native <dialog> default behavior and keeps this generic across dialogs
  // whose first focusable element isn't necessarily the right initial target
  // (e.g. ConfirmModal's destructive-confirm button).
  useFocusOnMount(dialog && open ? ref : NULL_REF)

  // Focus trap — Tab/Shift+Tab cycles within the overlay's focusable elements
  // instead of escaping into the page behind it. Restores focus to whatever
  // was focused before the dialog opened, on close/unmount.
  useEffect(() => {
    if (!open || !dialog) return
    const previouslyFocused = document.activeElement as HTMLElement | null

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Tab' || !ref.current) return
      const focusable = Array.from(
        ref.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => el.offsetParent !== null) // skip hidden elements
      if (focusable.length === 0) {
        e.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (active === first || !ref.current.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (active === last || !ref.current.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus?.()
    }
  }, [open, dialog])

  if (!open) return null
  const node = (
    <div
      ref={ref}
      role={dialog ? 'dialog' : undefined}
      aria-modal={dialog ? true : undefined}
      tabIndex={dialog ? -1 : undefined}
      className={className}
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>
  )
  return portal ? createPortal(node, document.body) : node
}
