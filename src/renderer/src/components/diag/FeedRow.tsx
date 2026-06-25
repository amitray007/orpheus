import type React from 'react'
import type { DiagEvent } from '@shared/types'

interface FeedRowProps {
  evt: DiagEvent
  isSelected: boolean
  onClick: () => void
}

function levelClass(level: string): string {
  switch (level) {
    case 'debug':
      return 'text-text-muted'
    case 'warn':
      return 'text-amber-400'
    case 'error':
    case 'fatal':
      return 'text-red-400'
    default:
      return 'text-text-secondary'
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

export function FeedRow({ evt, isSelected, onClick }: FeedRowProps): React.JSX.Element {
  const colorClass = levelClass(evt.level ?? '')
  const hasTrace = evt.traceId != null && evt.traceId !== ''
  const nameOrEvent = evt.name ?? evt.event ?? ''
  const catLevel = `${evt.category ?? ''}/${evt.level ?? ''}`

  return (
    <div
      onClick={onClick}
      className={[
        'flex items-baseline gap-2 px-3 py-0.5 text-xs font-mono leading-5 cursor-default select-text',
        isSelected
          ? 'bg-accent/15 border-l-2 border-accent/30'
          : 'hover:bg-surface-raised border-l-2 border-transparent',
        hasTrace ? 'cursor-pointer' : '',
        colorClass
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="shrink-0 text-text-muted">{formatTime(evt.ts)}</span>
      <span className="shrink-0 w-14 text-text-muted">{evt.process ?? 'main'}</span>
      <span className="shrink-0 w-24 opacity-70">{catLevel}</span>
      <span className="shrink-0 truncate max-w-[200px]">{nameOrEvent}</span>
      {evt.workspaceId != null && evt.workspaceId !== '' && (
        <span className="shrink-0 text-text-muted">ws={String(evt.workspaceId).slice(0, 8)}</span>
      )}
      {evt.durationMs != null && (
        <span className="shrink-0 text-text-muted">[{evt.durationMs}ms]</span>
      )}
      {evt.message != null && evt.message !== '' && (
        <span className="flex-1 truncate">{evt.message}</span>
      )}
      {hasTrace && <span className="shrink-0 text-text-muted opacity-50 text-[10px]">trace</span>}
    </div>
  )
}
