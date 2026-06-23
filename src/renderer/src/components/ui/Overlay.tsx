import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useOverlayOpen } from '@/lib/overlayFocus'

interface OverlayProps {
  open: boolean
  onDismiss?: () => void
  interactive?: boolean
  portal?: boolean
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}

// The single sanctioned way to paint DOM over the terminal. Registers overlay-open
// (drives the native focus handoff + z-swap via the coordinator) for its lifetime;
// optionally portals to body; and — when interactive — owns Escape + outside-click so
// overlays stop attaching their own focus-stealing document listeners. POSITIONING-
// AGNOSTIC: callers keep their own coordinate math via className/style or by rendering
// in place (portal={false}).
export function Overlay({
  open,
  onDismiss,
  interactive = false,
  portal = false,
  className,
  style,
  children
}: OverlayProps): React.JSX.Element | null {
  useOverlayOpen(open)
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
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  )
  return portal ? createPortal(node, document.body) : node
}
