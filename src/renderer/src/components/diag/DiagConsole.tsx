import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { DiagCategory, DiagEvent, DiagLevel } from '@shared/types'
import { FeedRow } from './FeedRow'
import { FilterBar, type FilterState } from './FilterBar'
import { TraceTree } from './TraceTree'

const RING_CAP = 5000
const RENDER_LIMIT = 500

const LEVEL_ORDER: DiagLevel[] = ['debug', 'info', 'warn', 'error', 'fatal']

function meetsLevel(evtLevel: string, minLevel: DiagLevel): boolean {
  const ei = LEVEL_ORDER.indexOf(evtLevel as DiagLevel)
  const mi = LEVEL_ORDER.indexOf(minLevel)
  if (ei === -1 || mi === -1) return true
  return ei >= mi
}

function matchesSearch(evt: DiagEvent, search: string): boolean {
  if (!search) return true
  const q = search.toLowerCase()
  const haystack = [evt.name ?? evt.event ?? '', evt.message ?? '', evt.workspaceId ?? '']
    .join(' ')
    .toLowerCase()
  return haystack.includes(q)
}

function applyFilters(ring: DiagEvent[], filters: FilterState): DiagEvent[] {
  return ring.filter(
    (evt) =>
      filters.categories.has(evt.category) &&
      meetsLevel(evt.level, filters.minLevel) &&
      matchesSearch(evt, filters.search)
  )
}

const ALL_CATEGORIES = new Set<DiagCategory>(['error', 'lifecycle', 'perf', 'anomaly', 'trace'])

export function DiagConsole(): React.JSX.Element {
  const ringRef = useRef<DiagEvent[]>([])
  const [snapshot, setSnapshot] = useState<DiagEvent[]>([])
  const [dropped, setDropped] = useState(0)
  const [totalReceived, setTotalReceived] = useState(0)
  const [paused, setPaused] = useState(false)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)
  const [filters, setFilters] = useState<FilterState>({
    categories: new Set(ALL_CATEGORIES),
    minLevel: 'debug',
    search: ''
  })

  const feedRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(false)

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  // Push incoming events into ring, then sync snapshot if not paused
  const pushBatch = useCallback((batch: unknown[]) => {
    const evts = batch as DiagEvent[]
    const ring = ringRef.current
    let newDropped = 0

    for (const evt of evts) {
      if (ring.length >= RING_CAP) {
        ring.shift()
        newDropped++
      }
      ring.push(evt)
    }

    setTotalReceived((n) => n + evts.length)
    if (newDropped > 0) setDropped((n) => n + newDropped)

    if (!pausedRef.current) {
      setSnapshot([...ring])
    }
  }, [])

  useEffect(() => {
    const unsub = window.api.diag.onStream(pushBatch)
    return unsub
  }, [pushBatch])

  // On resume, sync snapshot from ring
  useEffect(() => {
    if (!paused) {
      setSnapshot([...ringRef.current])
    }
  }, [paused])

  // Auto-scroll
  useEffect(() => {
    if (!paused && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight
    }
  }, [snapshot, paused])

  const filtered = useMemo(() => {
    const all = applyFilters(snapshot, filters)
    return all.slice(-RENDER_LIMIT)
  }, [snapshot, filters])

  function handleToggleCategory(cat: DiagCategory): void {
    setFilters((f) => {
      const next = new Set(f.categories)
      if (next.has(cat)) {
        next.delete(cat)
      } else {
        next.add(cat)
      }
      return { ...f, categories: next }
    })
  }

  function handleSetMinLevel(level: DiagLevel): void {
    setFilters((f) => ({ ...f, minLevel: level }))
  }

  function handleSetSearch(s: string): void {
    setFilters((f) => ({ ...f, search: s }))
  }

  function handleClear(): void {
    ringRef.current = []
    setSnapshot([])
    setDropped(0)
    setSelectedTraceId(null)
  }

  function handleRowClick(evt: DiagEvent): void {
    if (!evt.traceId) return
    setSelectedTraceId((cur) => (cur === evt.traceId ? null : (evt.traceId ?? null)))
  }

  const activeCatCount = filters.categories.size
  const filterSummary =
    activeCatCount === 5
      ? `all categories · ≥${filters.minLevel}`
      : `${activeCatCount} cats · ≥${filters.minLevel}`

  return (
    <div
      className="flex flex-col bg-[#0b0b0c] text-text-primary"
      style={{ height: '100vh', overflow: 'hidden' }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border-default bg-surface-raised shrink-0">
        <span className="font-pixel text-text-primary text-sm tracking-wide">
          Orpheus Diagnostics
        </span>
        <span
          className={[
            'text-[10px] font-mono px-1.5 py-0.5 rounded border',
            paused
              ? 'bg-amber-500/15 text-amber-400 border-amber-500/20'
              : 'bg-green-500/15 text-green-400 border-green-500/20'
          ].join(' ')}
        >
          {paused ? 'paused' : 'live'}
        </span>
        <span className="text-[11px] font-mono text-text-muted">
          {totalReceived} received
          {dropped > 0 && <span className="text-amber-400 ml-1">· {dropped} dropped</span>}
        </span>
        <span className="text-[11px] font-mono text-text-muted ml-auto">{filterSummary}</span>
      </div>

      {/* Filter bar */}
      <FilterBar
        filters={filters}
        paused={paused}
        onToggleCategory={handleToggleCategory}
        onSetMinLevel={handleSetMinLevel}
        onSetSearch={handleSetSearch}
        onTogglePause={() => setPaused((p) => !p)}
        onClear={handleClear}
      />

      {/* Feed */}
      <div
        ref={feedRef}
        className="flex-1 overflow-y-auto overflow-x-hidden"
        style={{ minHeight: 0 }}
      >
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-muted text-xs font-mono">
            no events
          </div>
        ) : (
          filtered.map((evt, i) => (
            <FeedRow
              key={i}
              evt={evt}
              isSelected={selectedTraceId != null && evt.traceId === selectedTraceId}
              onClick={() => handleRowClick(evt)}
            />
          ))
        )}
      </div>

      {/* Trace panel */}
      {selectedTraceId != null && (
        <TraceTree
          traceId={selectedTraceId}
          rows={snapshot}
          onClose={() => setSelectedTraceId(null)}
        />
      )}
    </div>
  )
}
