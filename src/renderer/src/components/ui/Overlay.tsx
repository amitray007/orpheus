import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

interface OverlayProps {
  open: boolean
  onDismiss?: () => void
  interactive?: boolean
  portal?: boolean
  className?: string
  style?: React.CSSProperties
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  children: React.ReactNode
}

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

  if (!open) return null
  const node = (
    <div
      ref={ref}
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
