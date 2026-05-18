import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type React from 'react'
import { SidebarSimple, ArrowSquareOut, PushPin } from '@phosphor-icons/react'
import type { ClaudeStatusSnapshot } from '@shared/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TopBarProps {
  onToggleCollapsed: () => void
  sidebarCollapsed: boolean
  sidebarWidth: number
}

// macOS traffic lights + toggle button need at least this much room before
// the workspace content starts.
const MIN_LEFT_WIDTH = 112

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

type Indicator = ClaudeStatusSnapshot['indicator']

function indicatorDotClass(indicator: Indicator | null): string {
  switch (indicator) {
    case 'none':
      return 'bg-green-500'
    case 'minor':
      return 'bg-amber-400'
    case 'major':
    case 'critical':
      return 'bg-red-500'
    case 'maintenance':
      return 'bg-blue-500'
    default:
      return 'bg-zinc-400'
  }
}

function chipLabel(snapshot: ClaudeStatusSnapshot | null, loading: boolean): string {
  if (loading) return 'Checking...'
  if (!snapshot) return 'Status unavailable'
  if (!snapshot.fetchOk) return 'Status unavailable'
  switch (snapshot.watchedIndicator) {
    case 'none':
      return 'Claude · Operational'
    case 'minor':
      return 'Claude API · Degraded'
    case 'major':
      return 'Claude · Partial outage'
    case 'critical':
      return 'Claude · Major outage'
    case 'maintenance':
      return 'Claude · Maintenance'
    default:
      return 'Claude · Unknown'
  }
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function componentStatusToIndicator(
  status: ClaudeStatusSnapshot['components'][number]['status']
): Indicator {
  switch (status) {
    case 'operational':
      return 'none'
    case 'degraded_performance':
      return 'minor'
    case 'partial_outage':
      return 'major'
    case 'major_outage':
      return 'critical'
    case 'under_maintenance':
      return 'maintenance'
    default:
      return 'none'
  }
}

function componentStatusLabel(
  status: ClaudeStatusSnapshot['components'][number]['status']
): string {
  switch (status) {
    case 'operational':
      return 'Operational'
    case 'degraded_performance':
      return 'Degraded'
    case 'partial_outage':
      return 'Partial outage'
    case 'major_outage':
      return 'Major outage'
    case 'under_maintenance':
      return 'Under maintenance'
    default:
      return status
  }
}

function impactLabel(impact: ClaudeStatusSnapshot['incidents'][number]['impact']): string {
  switch (impact) {
    case 'none':
      return 'None'
    case 'minor':
      return 'Minor'
    case 'major':
      return 'Major'
    case 'critical':
      return 'Critical'
    default:
      return impact
  }
}

// ---------------------------------------------------------------------------
// StatusPopover — portal-anchored, escape + outside-click dismissible
// ---------------------------------------------------------------------------

interface StatusPopoverProps {
  snapshot: ClaudeStatusSnapshot | null
  triggerRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}

function StatusPopover({ snapshot, triggerRef, onClose }: StatusPopoverProps): React.JSX.Element {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{
    left: number
    top: number | undefined
    bottom: number | undefined
    width: number
  } | null>(null)
  const [, setTick] = useState(0)

  // Tick every 10s to refresh relative timestamps in the popover
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000)
    return () => clearInterval(id)
  }, [])

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 8
    const estimatedHeight = 320
    const spaceBelow = window.innerHeight - rect.bottom - margin
    const above = spaceBelow < estimatedHeight && rect.top > estimatedHeight + margin
    setPos({
      left: Math.max(margin, rect.right - 320),
      top: above ? undefined : rect.bottom + 4,
      bottom: above ? window.innerHeight - rect.top + 4 : undefined,
      width: 320
    })
  }, [triggerRef])

  // Reposition on resize
  useEffect(() => {
    function reposition(): void {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const margin = 8
      const estimatedHeight = 320
      const spaceBelow = window.innerHeight - rect.bottom - margin
      const above = spaceBelow < estimatedHeight && rect.top > estimatedHeight + margin
      setPos({
        left: Math.max(margin, rect.right - 320),
        top: above ? undefined : rect.bottom + 4,
        bottom: above ? window.innerHeight - rect.top + 4 : undefined,
        width: 320
      })
    }
    window.addEventListener('resize', reposition)
    return () => window.removeEventListener('resize', reposition)
  }, [triggerRef])

  // Close on outside mousedown
  useEffect(() => {
    function onMouseDown(e: MouseEvent): void {
      const t = e.target as Node
      if (popoverRef.current?.contains(t)) return
      if (triggerRef.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [onClose, triggerRef])

  // Close on Escape
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        onClose()
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, triggerRef])

  function handleOpenPage(): void {
    window.api.status.openPage().catch(console.error)
    onClose()
  }

  return createPortal(
    <div
      ref={popoverRef}
      style={{
        position: 'fixed',
        left: pos?.left,
        top: pos?.top,
        bottom: pos?.bottom,
        width: pos?.width ?? 320,
        zIndex: 1000
      }}
      className="bg-surface-overlay border border-border-default rounded-lg shadow-xl overflow-hidden text-sm"
    >
      {snapshot ? (
        <>
          {/* Header */}
          <div className="px-4 py-3 border-b border-border-default/50">
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${indicatorDotClass(snapshot.watchedIndicator)}`}
              />
              <span className="text-xs font-medium text-text-primary truncate">
                {snapshot.description}
              </span>
            </div>
            <p className="text-[11px] text-text-muted mt-0.5">
              {snapshot.fetchOk
                ? `Last checked ${timeAgo(snapshot.fetchedAt)}`
                : `Stale · Last checked ${timeAgo(snapshot.fetchedAt)}`}
            </p>
          </div>

          {/* Components */}
          {snapshot.components.length > 0 && (
            <div className="px-4 py-2 flex flex-col gap-0.5 max-h-48 overflow-y-auto">
              {snapshot.components.map((c) => {
                const ind = componentStatusToIndicator(c.status)
                return (
                  <div key={c.id} className="flex items-center gap-2 py-1">
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${indicatorDotClass(ind)}`}
                    />
                    <span className="text-[11px] text-text-primary flex-1 truncate">{c.name}</span>
                    {c.watched && (
                      <PushPin
                        size={9}
                        className="text-text-muted flex-shrink-0"
                        aria-label="Watched component"
                      />
                    )}
                    <span
                      className={`text-[11px] flex-shrink-0 ${ind === 'none' ? 'text-text-muted' : 'text-text-primary'}`}
                    >
                      {componentStatusLabel(c.status)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {/* Incidents */}
          {snapshot.incidents.length > 0 && (
            <div className="px-4 py-2 border-t border-border-default/50">
              <p className="text-[10px] uppercase tracking-wider font-medium text-text-muted mb-1.5">
                Active incidents
              </p>
              {snapshot.incidents.map((inc) => (
                <div key={inc.id} className="py-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium text-text-primary truncate">
                      {inc.name}
                    </span>
                    <span className="flex-shrink-0 text-[9px] uppercase border border-border-default rounded px-1 py-0.5 text-text-muted leading-none">
                      {impactLabel(inc.impact)}
                    </span>
                  </div>
                  <p className="text-[10px] text-text-muted">
                    {inc.status} &middot; Updated {timeAgo(new Date(inc.updatedAt).getTime())}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Footer */}
          <div className="px-4 py-2 border-t border-border-default/50">
            <button
              type="button"
              onClick={handleOpenPage}
              className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary transition-colors cursor-pointer focus-visible:outline-none"
            >
              View status page
              <ArrowSquareOut size={11} />
            </button>
          </div>
        </>
      ) : (
        <div className="px-4 py-3">
          <p className="text-[11px] text-text-muted">Status not yet available.</p>
        </div>
      )}
    </div>,
    document.body
  )
}

// ---------------------------------------------------------------------------
// StatusChip — the always-visible top-bar button
// ---------------------------------------------------------------------------

function StatusChip(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ClaudeStatusSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [, setTick] = useState(0)

  // Tick every 15s to keep the "Checking..." label fresh
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api.status
      .get()
      .then((s) => {
        if (cancelled) return
        setSnapshot(s)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })

    const off = window.api.status.onChange((s) => {
      if (cancelled) return
      setSnapshot(s)
      setLoading(false)
    })

    return () => {
      cancelled = true
      off()
    }
  }, [])

  const chipIndicator = snapshot?.fetchOk !== false ? (snapshot?.watchedIndicator ?? null) : null
  const label = chipLabel(snapshot, loading && !snapshot)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Claude service status"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 flex-shrink-0"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${indicatorDotClass(chipIndicator)}`}
        />
        <span className="whitespace-nowrap">{label}</span>
      </button>
      {open && (
        <StatusPopover snapshot={snapshot} triggerRef={triggerRef} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------

export function TopBar({
  onToggleCollapsed,
  sidebarCollapsed,
  sidebarWidth
}: TopBarProps): React.JSX.Element {
  // Left section aligns with the sidebar's right edge when expanded so the
  // workspace title bar lines up with the content area below it.
  const leftWidth = sidebarCollapsed ? MIN_LEFT_WIDTH : Math.max(MIN_LEFT_WIDTH, sidebarWidth)

  return (
    <header
      className="h-11 flex items-stretch bg-surface-raised border-b border-border-default flex-shrink-0"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center flex-shrink-0" style={{ width: leftWidth }}>
        {/* Traffic-light spacer — reserves 80px on the left */}
        <div className="w-[80px] flex-shrink-0" />

        {/* Sidebar collapse toggle */}
        <button
          onClick={onToggleCollapsed}
          aria-label="Toggle sidebar"
          title="Toggle sidebar"
          className="w-8 h-8 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <SidebarSimple size={16} />
        </button>

        <div className="flex-1" />
      </div>

      {/* Workspace title bar gets portaled into here when in workspace view */}
      <div id="topbar-workspace-slot" className="flex-1 flex items-center min-w-0" />

      {/* Status chip — right side, after workspace slot */}
      <div className="flex items-center pr-3 flex-shrink-0">
        <StatusChip />
      </div>
    </header>
  )
}
