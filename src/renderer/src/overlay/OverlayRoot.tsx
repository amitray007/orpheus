import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { OverlayDescriptor } from '@shared/types'
import { registry } from './registry'
import { OverlayErrorBoundary, OverlayErrorCard } from './OverlayErrorBoundary'

type Phase = 'entering' | 'visible' | 'exiting'

interface ShownState {
  descriptor: OverlayDescriptor
  generation: number
  phase: Phase
}

const ENTER_MS = 120
const EXIT_MS = 100

/**
 * The overlay renderer's single React root. Owns the show/update/hide
 * lifecycle for whichever descriptor main most recently pushed, the
 * paint-ack handshake, entrance/exit fades, Escape-to-cancel for
 * takesFocus descriptors, the hover bridge, and size reporting.
 */
export function OverlayRoot(): React.JSX.Element | null {
  const [state, setState] = useState<ShownState | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Mirrors state in a ref so async callbacks (rAF, ResizeObserver, timers)
  // always compare against the latest id+generation without going stale.
  const stateRef = useRef<ShownState | null>(null)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const emit = useCallback(
    (overlayId: string, kind: string, type: string, payload?: Record<string, unknown>): void => {
      window.overlayApi.sendEvent({ overlayId, kind, type, payload })
    },
    []
  )

  // --- onShow: replace whatever is currently shown, reset to entering ---
  useEffect(() => {
    const unsubscribe = window.overlayApi.onShow(({ descriptor, generation, theme }) => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
      // Every show carries the current theme, closing the first-show race
      // where no onThemeChange push has arrived yet.
      document.documentElement.dataset.theme = theme
      setState({ descriptor, generation, phase: 'entering' })
    })
    return unsubscribe
  }, [])

  // --- onUpdate: shallow-merge props into the current descriptor if id+gen match ---
  useEffect(() => {
    const unsubscribe = window.overlayApi.onUpdate(({ id, generation, props }) => {
      setState((prev) => {
        if (!prev || prev.descriptor.id !== id || prev.generation !== generation) return prev
        return {
          ...prev,
          descriptor: { ...prev.descriptor, props: { ...prev.descriptor.props, ...props } }
        }
      })
    })
    return unsubscribe
  }, [])

  // --- onHide: play exit fade, emit `exited`, then clear ---
  useEffect(() => {
    const unsubscribe = window.overlayApi.onHide(({ id, generation }) => {
      const current = stateRef.current
      if (!current || current.descriptor.id !== id || current.generation !== generation) return
      setState((prev) =>
        prev && prev.descriptor.id === id && prev.generation === generation
          ? { ...prev, phase: 'exiting' }
          : prev
      )
      exitTimerRef.current = setTimeout(() => {
        const stillCurrent = stateRef.current
        if (
          stillCurrent &&
          stillCurrent.descriptor.id === id &&
          stillCurrent.generation === generation
        ) {
          emit(id, stillCurrent.descriptor.kind, 'exited')
          setState(null)
        }
      }, EXIT_MS)
    })
    return () => {
      unsubscribe()
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
    }
  }, [emit])

  // --- onThemeChange: apply to <html data-theme> like the main renderer ---
  useEffect(() => {
    const unsubscribe = window.overlayApi.onThemeChange((theme) => {
      document.documentElement.dataset.theme = theme
    })
    return unsubscribe
  }, [])

  // --- Paint-ack handshake: double-rAF after a new show, then ackPainted; then fade in ---
  useEffect(() => {
    if (!state || state.phase !== 'entering') return
    const { descriptor, generation } = state
    let cancelled = false
    let raf2: number | null = null
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (cancelled) return
        window.overlayApi.ackPainted({ id: descriptor.id, generation })
        setState((prev) =>
          prev && prev.descriptor.id === descriptor.id && prev.generation === generation
            ? { ...prev, phase: 'visible' }
            : prev
        )
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf1)
      if (raf2 !== null) cancelAnimationFrame(raf2)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.descriptor.id, state?.generation, state?.phase])

  // --- Error boundary onError: still ack (with error) so the handshake never strands ---
  const handleKindError = useCallback((error: string): void => {
    const current = stateRef.current
    if (!current) return
    window.overlayApi.ackPainted({
      id: current.descriptor.id,
      generation: current.generation,
      error
    })
  }, [])

  // --- Escape while a takesFocus descriptor is shown ---
  useEffect(() => {
    if (!state || !state.descriptor.takesFocus) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      emit(state.descriptor.id, state.descriptor.kind, 'cancel')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state, emit])

  // --- ResizeObserver on the card wrapper (anchored mode only) ---
  useEffect(() => {
    if (!state || state.descriptor.placement.mode !== 'anchored') return
    const node = cardRef.current
    if (!node) return
    const { id } = state.descriptor
    const generation = state.generation
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const box = entry.borderBoxSize?.[0]
      const w = box ? box.inlineSize : entry.contentRect.width
      const h = box ? box.blockSize : entry.contentRect.height
      window.overlayApi.reportSize({ id, generation, w, h })
    })
    observer.observe(node, { box: 'border-box' })
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.descriptor.id, state?.generation, state?.descriptor.placement.mode])

  const emitCurrent = useMemo(() => {
    if (!state) return null
    const { id, kind } = state.descriptor
    return (type: string, payload?: Record<string, unknown>): void => emit(id, kind, type, payload)
  }, [state, emit])

  if (!state || !emitCurrent) return null

  const { descriptor, phase } = state
  const Kind = registry[descriptor.kind]
  const isCentered = descriptor.placement.mode === 'centered'
  const opacity = phase === 'visible' ? 1 : 0
  const transition = `opacity ${phase === 'exiting' ? EXIT_MS : ENTER_MS}ms ease-out`

  const onCardMouseEnter = (): void => emitCurrent('mouseenter')
  const onCardMouseLeave = (): void => emitCurrent('mouseleave')

  return (
    <div
      ref={cardRef}
      className={isCentered ? 'flex h-full w-full items-center justify-center' : 'inline-block'}
      style={
        isCentered
          ? { opacity, transition }
          : { opacity, transition, width: 'max-content', height: 'max-content', maxWidth: 'none' }
      }
      onMouseEnter={onCardMouseEnter}
      onMouseLeave={onCardMouseLeave}
    >
      {Kind ? (
        <OverlayErrorBoundary kind={descriptor.kind} onError={handleKindError}>
          <Kind descriptor={descriptor} props={descriptor.props} emit={emitCurrent} />
        </OverlayErrorBoundary>
      ) : (
        <UnknownKind kind={descriptor.kind} id={descriptor.id} generation={state.generation} />
      )}
    </div>
  )
}

/** Unknown kind: render the error card and still ack with an error, same contract as a throwing kind. */
function UnknownKind({
  kind,
  id,
  generation
}: {
  kind: string
  id: string
  generation: number
}): React.JSX.Element {
  useEffect(() => {
    window.overlayApi.ackPainted({ id, generation, error: `Unknown overlay kind: ${kind}` })
  }, [id, generation, kind])
  return <OverlayErrorCard kind={kind} />
}
