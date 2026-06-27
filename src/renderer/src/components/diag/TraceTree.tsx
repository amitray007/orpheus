import { useMemo } from 'react'
import type React from 'react'
import { Copy, X } from '@phosphor-icons/react'
import { formatTraceTree } from '@shared/diagFormat'
import type { DiagEvent } from '@shared/types'

interface TraceTreeProps {
  traceId: string
  rows: DiagEvent[]
  onClose: () => void
}

export function TraceTree({ traceId, rows, onClose }: TraceTreeProps): React.JSX.Element {
  const traceRows = useMemo(() => rows.filter((r) => r.traceId === traceId), [rows, traceId])
  const tree = useMemo(
    () => formatTraceTree(traceRows as unknown as Array<Record<string, unknown>>),
    [traceRows]
  )

  function handleCopyJson(): void {
    window.api.shell.copyToClipboard(JSON.stringify(traceRows, null, 2)).catch(() => {
      /* best-effort */
    })
  }

  return (
    <div
      className="border-t border-border-default bg-surface-raised flex flex-col"
      style={{ height: 240 }}
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-default shrink-0">
        <span className="text-[11px] font-mono text-text-muted">
          trace <span className="text-text-secondary">{traceId.slice(0, 16)}</span>
          <span className="ml-2 text-text-muted">({traceRows.length} rows)</span>
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopyJson}
            className="flex items-center gap-1 px-2 py-0.5 rounded border border-border-default text-[11px] font-mono text-text-muted hover:border-border-hover hover:text-text-secondary transition-colors"
          >
            <Copy size={11} />
            Copy JSON
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      </div>
      <pre className="flex-1 overflow-auto px-3 py-2 text-[11px] font-mono text-text-secondary leading-5 whitespace-pre">
        {tree}
      </pre>
    </div>
  )
}
