import { useCallback, useRef } from 'react'

export interface UseOverlayHoverCardOptions {
  /** Delay (ms) before the "open" callback fires after the pointer enters. */
  openDelay: number
  /** Delay (ms) before the "close" callback fires after the pointer leaves. */
  closeDelay: number
}

export interface UseOverlayHoverCardResult {
  /** Call from the trigger's onMouseEnter. Cancels any pending close and schedules `onOpen` after `openDelay`. */
  handleMouseEnter: (onOpen: () => void) => void
  /** Call from the trigger's onMouseLeave. Cancels any pending open and schedules `onClose` after `closeDelay`. */
  handleMouseLeave: (onClose: () => void) => void
  /** Cancels any pending open/close timer without scheduling a new one. */
  clearTimer: () => void
  /**
   * Re-arms the close timer at `closeDelay` — used as the hover-bridge
   * onLeave handler (e.g. via overlayClient's onCardPointer) so moving the
   * pointer off the overlay card itself schedules the same close as leaving
   * the trigger row.
   */
  armClose: (onClose: () => void) => void
}

/**
 * Shared open/close timer machinery for anchor-hover-triggered overlay cards
 * (Sidebar workspace sub-row, WorkspaceTitleBar details popover, collapsed
 * project tiles). Callers own what "open"/"close" actually do (building card
 * props, calling showXCard/hideOverlayCard) — this hook only owns the timer
 * bookkeeping, mirroring the hand-rolled `hoverTimerRef` pattern each call
 * site had before extraction.
 */
export function useOverlayHoverCard({
  openDelay,
  closeDelay
}: UseOverlayHoverCardOptions): UseOverlayHoverCardResult {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const handleMouseEnter = useCallback(
    (onOpen: () => void): void => {
      clearTimer()
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        onOpen()
      }, openDelay)
    },
    [clearTimer, openDelay]
  )

  const handleMouseLeave = useCallback(
    (onClose: () => void): void => {
      clearTimer()
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        onClose()
      }, closeDelay)
    },
    [clearTimer, closeDelay]
  )

  const armClose = useCallback(
    (onClose: () => void): void => {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        onClose()
      }, closeDelay)
    },
    [closeDelay]
  )

  return { handleMouseEnter, handleMouseLeave, clearTimer, armClose }
}
