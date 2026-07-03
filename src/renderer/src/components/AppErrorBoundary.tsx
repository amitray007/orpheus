import { Component, useState } from 'react'
import type React from 'react'
import { logDiag } from '@/lib/diag'
import { DIAG_EVENTS } from '@shared/diagEvents'

interface AppErrorBoundaryState {
  error: string | null
}

/**
 * Top-level React error boundary. If any renderer component throws during
 * render, this catches it, reports the error via diagnostics, and shows a
 * full-window recovery card instead of a blank/broken app.
 */
export class AppErrorBoundary extends Component<
  { children: React.ReactNode },
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    logDiag({
      category: 'error',
      level: 'error',
      event: DIAG_EVENTS.ERROR_RENDERER,
      message: error instanceof Error ? error.message : String(error),
      data: {
        stack: error instanceof Error ? (error.stack ?? null) : null,
        componentStack: info.componentStack ?? null,
        boundary: 'AppErrorBoundary'
      }
    })
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return <AppErrorCard error={this.state.error} />
    }
    return this.props.children
  }
}

type ExportStatus = 'idle' | 'exporting' | 'done' | 'error'

function AppErrorCard({ error }: { error: string }): React.JSX.Element {
  const [status, setStatus] = useState<ExportStatus>('idle')
  const [exportMessage, setExportMessage] = useState<string | null>(null)

  function handleExport(): void {
    setStatus('exporting')
    setExportMessage(null)
    window.api.diag
      .export({ sinceMs: Date.now() - 86_400_000 })
      .then((res) => {
        if (!res.ok) {
          if (res.error === 'canceled') {
            setStatus('idle')
          } else {
            setStatus('error')
            setExportMessage(res.error)
          }
        } else {
          setStatus('done')
          setExportMessage(res.txtPath ?? res.path ?? null)
        }
      })
      .catch((err: unknown) => {
        setStatus('error')
        setExportMessage(err instanceof Error ? err.message : String(err))
      })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative max-w-md w-full mx-4 bg-surface-overlay border border-border-default rounded-lg p-6 flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-text-primary">Something went wrong</h2>
        <p className="text-sm text-text-secondary">
          Orpheus hit an unexpected error and couldn&apos;t continue rendering this view.
        </p>
        <pre className="max-h-40 overflow-auto rounded-md border border-border-default bg-surface-raised px-3 py-2 text-[11px] text-text-muted whitespace-pre-wrap break-words">
          {error}
        </pre>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-text-primary px-3 py-1.5 text-xs font-medium text-surface-overlay hover:opacity-90 transition-opacity cursor-pointer"
          >
            Reload
          </button>
          <button
            type="button"
            disabled={status === 'exporting'}
            onClick={handleExport}
            className="rounded-md border border-border-default bg-surface-raised px-3 py-1.5 text-xs font-medium text-text-primary hover:border-border-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {status === 'exporting' ? 'Exporting…' : 'Export diagnostics'}
          </button>
        </div>
        {status === 'done' && (
          <p className="text-xs text-green-400">
            Saved{exportMessage ? ` ${exportMessage}` : ''} (+ .json)
          </p>
        )}
        {status === 'error' && (
          <p className="text-xs text-red-400">
            Export failed{exportMessage ? `: ${exportMessage}` : ''}
          </p>
        )}
      </div>
    </div>
  )
}
