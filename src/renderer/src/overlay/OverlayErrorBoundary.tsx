import { Component } from 'react'
import type React from 'react'

interface OverlayErrorBoundaryProps {
  kind: string
  /** Called once, synchronously from componentDidCatch, so the paint-ack handshake never strands. */
  onError: (error: string) => void
  children: React.ReactNode
}

interface OverlayErrorBoundaryState {
  error: string | null
}

/**
 * Wraps a single overlay kind. A throwing kind must never strand the
 * ackPainted handshake — on catch we render a minimal error card AND still
 * report the error up so OverlayRoot can ack with `{ error }`.
 */
export class OverlayErrorBoundary extends Component<
  OverlayErrorBoundaryProps,
  OverlayErrorBoundaryState
> {
  state: OverlayErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): OverlayErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown): void {
    this.props.onError(error instanceof Error ? error.message : String(error))
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return <OverlayErrorCard kind={this.props.kind} error={this.state.error} />
    }
    return this.props.children
  }
}

export function OverlayErrorCard({
  kind,
  error
}: {
  kind: string
  error?: string
}): React.JSX.Element {
  return (
    <div className="min-w-[220px] max-w-[320px] rounded-lg border border-border-default bg-surface-raised px-3 py-2.5 font-[family-name:var(--font-sans)] shadow-lg">
      <p className="text-sm font-medium text-text-primary">Something went wrong</p>
      <p className="mt-0.5 text-xs text-text-muted">{kind}</p>
      {error && <p className="mt-1 truncate text-[11px] text-text-muted">{error}</p>}
    </div>
  )
}
