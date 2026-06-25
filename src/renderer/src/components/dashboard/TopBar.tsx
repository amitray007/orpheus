import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type React from 'react'
import { Overlay } from '@/components/ui/Overlay'
import {
  SidebarSimple,
  ArrowSquareOut,
  ArrowClockwise,
  WifiHigh,
  WifiMedium,
  WifiLow,
  WifiX,
  WifiSlash,
  Wrench
} from '@phosphor-icons/react'
import type { ClaudeStatusSnapshot } from '@shared/types'
import { BRAILLE_FRAMES, useAnimatedFrame } from '@/lib/braille'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TopBarProps {
  onToggleCollapsed: () => void
  sidebarCollapsed: boolean
  sidebarWidth: number
}

// macOS traffic lights + toggle button + status chip need at least this much
// room before the workspace content starts.
const MIN_LEFT_WIDTH = 144

// Components filtered out of the popover and settings list
const HIDDEN_COMPONENT_NAMES = new Set(['Claude for Government', 'Claude Cowork'])

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

function chipTooltip(snapshot: ClaudeStatusSnapshot): string {
  if (snapshot.isFetching && snapshot.fetchedAt === null) return 'Claude APIs are being checked'
  if (snapshot.isFetching) return 'Claude · Checking now'
  if (!snapshot.fetchOk) return 'Claude · Status unavailable'
  switch (snapshot.watchedIndicator) {
    case 'none':
      return 'Claude · Operational'
    case 'minor':
      return 'Claude API · Degraded performance'
    case 'major':
      return 'Claude · Partial outage'
    case 'critical':
      return 'Claude · Major outage'
    case 'maintenance':
      return 'Claude · Under maintenance'
    default:
      return 'Claude · Unknown'
  }
}

/**
 * Parse names like "Claude Console (platform.claude.com)" into a primary line
 * and an optional subtitle. Names without parens return subtitle=null.
 */
function parseComponentName(name: string): { primary: string; subtitle: string | null } {
  const m = name.match(/^(.+?)\s*\(([^)]+)\)\s*$/)
  if (!m) return { primary: name, subtitle: null }
  return { primary: m[1], subtitle: m[2] }
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
// StatusIcon — the Phosphor icon that represents the current indicator
// ---------------------------------------------------------------------------

interface StatusIconProps {
  indicator: Indicator | null
  loading: boolean
}

function StatusIcon({ indicator, loading }: StatusIconProps): React.JSX.Element {
  const braille = useAnimatedFrame(BRAILLE_FRAMES, 80, loading)

  if (loading) {
    return (
      <span className="text-text-secondary font-mono text-xs leading-none w-4 h-4 inline-flex items-center justify-center">
        {braille}
      </span>
    )
  }

  switch (indicator) {
    case 'none':
      return <WifiHigh size={16} className="text-green-500" weight="bold" />
    case 'minor':
      return <WifiMedium size={16} className="text-amber-400" weight="bold" />
    case 'major':
      return <WifiLow size={16} className="text-orange-500" weight="bold" />
    case 'critical':
      return <WifiX size={16} className="text-red-500" weight="bold" />
    case 'maintenance':
      return <Wrench size={16} className="text-blue-400" weight="bold" />
    default:
      return <WifiSlash size={16} className="text-text-secondary" weight="bold" />
  }
}

// ---------------------------------------------------------------------------
// StatusPopover — sidebar-constrained in-renderer portal popover
// ---------------------------------------------------------------------------

interface StatusPopoverProps {
  snapshot: ClaudeStatusSnapshot
  triggerRef: React.RefObject<HTMLButtonElement | null>
  sidebarWidth: number
  onClose: () => void
  onPopoverEnter?: () => void
  onPopoverLeave?: () => void
}

function StatusPopover({
  snapshot,
  triggerRef,
  sidebarWidth,
  onClose,
  onPopoverEnter,
  onPopoverLeave
}: StatusPopoverProps): React.JSX.Element {
  const headerBraille = useAnimatedFrame(BRAILLE_FRAMES, 80, snapshot.isFetching)
  const [pos, setPos] = useState<{
    left: number
    top: number
    width: number
  } | null>(null)
  const [, setTick] = useState(0)

  // Tick every 10s to refresh relative timestamps in the popover
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000)
    return () => clearInterval(id)
  }, [])

  // Compute and apply position: anchored below chip, constrained to sidebar bounds
  useLayoutEffect(() => {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const maxWidth = Math.min(320, sidebarWidth - 8)
    setPos({ left: 4, top: rect.bottom + 6, width: maxWidth })
  }, [triggerRef, sidebarWidth])

  // Reposition on resize
  useEffect(() => {
    function reposition(): void {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const maxWidth = Math.min(320, sidebarWidth - 8)
      setPos({ left: 4, top: rect.bottom + 6, width: maxWidth })
    }
    window.addEventListener('resize', reposition)
    return () => window.removeEventListener('resize', reposition)
  }, [triggerRef, sidebarWidth])

  function handleOpenPage(): void {
    window.api.status.openPage().catch(console.error)
    onClose()
  }

  function handleRefresh(): void {
    window.api.status.refresh().catch(console.error)
  }

  const visibleComponents = snapshot.components.filter((c) => !HIDDEN_COMPONENT_NAMES.has(c.name))
  const hasData = snapshot.fetchedAt !== null && visibleComponents.length > 0
  const initialLoading = snapshot.isFetching && !hasData

  return (
    <Overlay
      open
      interactive
      onDismiss={onClose}
      portal
      style={{
        position: 'fixed',
        left: pos?.left ?? 4,
        top: pos?.top ?? 40,
        width: pos?.width ?? 312,
        zIndex: 1000
      }}
      className="bg-surface-overlay border border-border-default rounded-lg shadow-xl overflow-hidden text-sm"
      onMouseEnter={onPopoverEnter}
      onMouseLeave={onPopoverLeave}
    >
      {initialLoading ? (
        <>
          <div className="px-4 py-5 flex items-center justify-center gap-2">
            <span className="text-text-secondary font-mono text-xs leading-none">
              {headerBraille}
            </span>
            <span className="text-xs text-text-secondary">Claude APIs are being checked</span>
          </div>
          <div className="px-4 py-2 border-t border-border-default/50">
            <button
              type="button"
              onClick={handleOpenPage}
              className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors cursor-pointer focus-visible:outline-none"
            >
              View status page
              <ArrowSquareOut size={11} />
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Header */}
          <div className="px-4 py-3 border-b border-border-default/50">
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${indicatorDotClass(snapshot.fetchOk ? snapshot.watchedIndicator : null)}`}
              />
              <span className="text-xs font-medium text-text-primary truncate flex-1">
                {snapshot.description}
              </span>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={snapshot.isFetching}
                aria-label="Refresh status now"
                title="Refresh now"
                className="w-5 h-5 inline-flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex-shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
              >
                <ArrowClockwise size={11} />
              </button>
            </div>
            <p className="text-sm text-text-muted mt-0.5 flex items-center gap-1.5">
              {snapshot.isFetching ? (
                <>
                  <span className="text-text-secondary font-mono leading-none">
                    {headerBraille}
                  </span>
                  <span>Checking now</span>
                </>
              ) : snapshot.fetchedAt !== null ? (
                snapshot.fetchOk ? (
                  `Last checked ${timeAgo(snapshot.fetchedAt)}`
                ) : (
                  `Stale · Last checked ${timeAgo(snapshot.fetchedAt)}`
                )
              ) : null}
            </p>
          </div>

          {/* Components (filtered, two-line) */}
          {visibleComponents.length > 0 && (
            <div className="px-4 py-2 flex flex-col gap-0.5 max-h-56 overflow-y-auto">
              {visibleComponents.map((c) => {
                const ind = componentStatusToIndicator(c.status)
                const { primary, subtitle } = parseComponentName(c.name)
                return (
                  <div key={c.id} className="flex items-start gap-2 py-1">
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${indicatorDotClass(ind)}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary truncate leading-tight">{primary}</p>
                      {subtitle && (
                        <p className="text-xs text-text-muted truncate leading-tight">{subtitle}</p>
                      )}
                    </div>
                    <span
                      className={`text-sm flex-shrink-0 mt-0.5 ${ind === 'none' ? 'text-text-muted' : 'text-text-primary'}`}
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
              <p className="text-xs uppercase tracking-wider font-medium text-text-muted mb-1.5">
                Active incidents
              </p>
              {snapshot.incidents.map((inc) => (
                <div key={inc.id} className="py-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-text-primary truncate">
                      {inc.name}
                    </span>
                    <span className="flex-shrink-0 text-xs uppercase border border-border-default rounded px-1 py-0.5 text-text-muted leading-none">
                      {impactLabel(inc.impact)}
                    </span>
                  </div>
                  <p className="text-xs text-text-muted">
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
              className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary transition-colors cursor-pointer focus-visible:outline-none"
            >
              View status page
              <ArrowSquareOut size={11} />
            </button>
          </div>
        </>
      )}
    </Overlay>
  )
}

// ---------------------------------------------------------------------------
// StatusChip — compact icon-only button in the left section
// ---------------------------------------------------------------------------

interface StatusChipProps {
  sidebarWidth: number
  sidebarCollapsed: boolean
  onToggleCollapsed: () => void
}

function StatusChip({
  sidebarWidth,
  sidebarCollapsed,
  onToggleCollapsed
}: StatusChipProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<ClaudeStatusSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.status
      .get()
      .then((s) => {
        if (!cancelled) setSnapshot(s)
      })
      .catch(console.error)

    const off = window.api.status.onChange((s) => {
      if (!cancelled) setSnapshot(s)
    })

    return () => {
      cancelled = true
      off()
    }
  }, [])

  // Show the spinner whenever a fetch is in flight (initial or refresh)
  const isFetching = snapshot?.isFetching ?? true
  const chipIndicator =
    snapshot && !isFetching && snapshot.fetchOk ? snapshot.watchedIndicator : null
  const tooltip = snapshot ? chipTooltip(snapshot) : 'Claude APIs are being checked'

  function handleClick(): void {
    if (sidebarCollapsed) {
      onToggleCollapsed()
      requestAnimationFrame(() => {
        setOpen(true)
      })
    } else {
      setOpen((o) => !o)
    }
  }

  function cancelClose(): void {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  function openNow(): void {
    cancelClose()
    setOpen(true)
  }

  function scheduleClose(): void {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 180)
  }

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
    },
    []
  )

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleClick}
        onMouseEnter={() => {
          if (!sidebarCollapsed) openNow()
        }}
        onMouseLeave={scheduleClose}
        aria-label={tooltip}
        title={tooltip}
        aria-expanded={open}
        className="w-8 h-8 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 flex-shrink-0"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <StatusIcon indicator={chipIndicator} loading={isFetching} />
      </button>
      {open && snapshot && (
        <StatusPopover
          snapshot={snapshot}
          triggerRef={triggerRef}
          sidebarWidth={sidebarWidth}
          onClose={() => setOpen(false)}
          onPopoverEnter={cancelClose}
          onPopoverLeave={scheduleClose}
        />
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

        {/* Status chip — immediately after sidebar toggle */}
        <StatusChip
          sidebarWidth={sidebarWidth}
          sidebarCollapsed={sidebarCollapsed}
          onToggleCollapsed={onToggleCollapsed}
        />

        {__ORPHEUS_MODE__ === 'development' && (
          <span
            className="ml-2 px-1.5 py-0.5 text-[10px] font-mono font-semibold tracking-widest uppercase rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 leading-none flex-shrink-0"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            DEV
          </span>
        )}

        <div className="flex-1" />
      </div>

      {/* Workspace title bar gets portaled into here when in workspace view */}
      <div id="topbar-workspace-slot" className="flex-1 flex items-center min-w-0" />
    </header>
  )
}
