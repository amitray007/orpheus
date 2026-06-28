import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { Icon } from '@phosphor-icons/react'
import {
  Gear,
  MagnifyingGlass,
  Monitor,
  ShieldCheck,
  Key,
  Brain,
  Wrench,
  FlowArrow,
  Code,
  Info,
  SidebarSimple,
  AppWindow,
  ArrowsClockwise,
  Command,
  Robot,
  Bell,
  Pulse,
  Lightning,
  Terminal,
  Stack,
  FirstAidKit,
  Coffee
} from '@phosphor-icons/react'
import { SETTINGS_SEARCH_INDEX } from './settings/searchIndex'
import { searchSettings } from './settings/searchMatcher'
import type { SettingsSearchResult } from './settings/searchMatcher'
import { SettingsSectionSkeleton } from '../Skeleton'

const ClaudeGeneralSection = lazy(() =>
  import('./settings/ClaudeGeneralSection').then((m) => ({ default: m.ClaudeGeneralSection }))
)
const ClaudeDisplaySection = lazy(() =>
  import('./settings/ClaudeDisplaySection').then((m) => ({ default: m.ClaudeDisplaySection }))
)
const ClaudePermissionsSection = lazy(() =>
  import('./settings/ClaudePermissionsSection').then((m) => ({
    default: m.ClaudePermissionsSection
  }))
)
const ClaudeAuthSection = lazy(() =>
  import('./settings/ClaudeAuthSection').then((m) => ({ default: m.ClaudeAuthSection }))
)
const ClaudeMemorySection = lazy(() =>
  import('./settings/ClaudeMemorySection').then((m) => ({ default: m.ClaudeMemorySection }))
)
const ClaudeToolsSection = lazy(() =>
  import('./settings/ClaudeToolsSection').then((m) => ({ default: m.ClaudeToolsSection }))
)
const ClaudeSlashCommandsSection = lazy(() =>
  import('./settings/ClaudeSlashCommandsSection').then((m) => ({
    default: m.ClaudeSlashCommandsSection
  }))
)
const ClaudeSubagentsSection = lazy(() =>
  import('./settings/ClaudeSubagentsSection').then((m) => ({ default: m.ClaudeSubagentsSection }))
)
const ClaudeHooksSection = lazy(() =>
  import('./settings/ClaudeHooksSection').then((m) => ({ default: m.ClaudeHooksSection }))
)
const ClaudeDeveloperSection = lazy(() =>
  import('./settings/ClaudeDeveloperSection').then((m) => ({ default: m.ClaudeDeveloperSection }))
)
const ClaudeAboutSection = lazy(() =>
  import('./settings/ClaudeAboutSection').then((m) => ({ default: m.ClaudeAboutSection }))
)
const OrpheusAppearanceSection = lazy(() =>
  import('./settings/OrpheusAppearanceSection').then((m) => ({
    default: m.OrpheusAppearanceSection
  }))
)
const OrpheusSidebarSection = lazy(() =>
  import('./settings/OrpheusSidebarSection').then((m) => ({ default: m.OrpheusSidebarSection }))
)
const OrpheusTerminalSection = lazy(() =>
  import('./settings/OrpheusTerminalSection').then((m) => ({ default: m.OrpheusTerminalSection }))
)
const OrpheusWindowSection = lazy(() =>
  import('./settings/OrpheusWindowSection').then((m) => ({ default: m.OrpheusWindowSection }))
)
const OrpheusNotificationsSection = lazy(() =>
  import('./settings/OrpheusNotificationsSection').then((m) => ({
    default: m.OrpheusNotificationsSection
  }))
)
const OrpheusWorkspacesSection = lazy(() =>
  import('./settings/OrpheusWorkspacesSection').then((m) => ({
    default: m.OrpheusWorkspacesSection
  }))
)
const OrpheusKeepAwakeSection = lazy(() =>
  import('./settings/OrpheusKeepAwakeSection').then((m) => ({ default: m.OrpheusKeepAwakeSection }))
)
const OrpheusUpdatesSection = lazy(() =>
  import('./settings/OrpheusUpdatesSection').then((m) => ({ default: m.OrpheusUpdatesSection }))
)
const OrpheusStatusSection = lazy(() =>
  import('./settings/OrpheusStatusSection').then((m) => ({ default: m.OrpheusStatusSection }))
)
const OrpheusFooterSection = lazy(() =>
  import('./settings/OrpheusFooterSection').then((m) => ({ default: m.OrpheusFooterSection }))
)
const OrpheusDeveloperSection = lazy(() =>
  import('./settings/OrpheusDeveloperSection').then((m) => ({ default: m.OrpheusDeveloperSection }))
)
const OrpheusDiagnosticsSection = lazy(() =>
  import('./settings/OrpheusDiagnosticsSection').then((m) => ({
    default: m.OrpheusDiagnosticsSection
  }))
)
const OrpheusHealthSection = lazy(() =>
  import('./settings/OrpheusHealthSection').then((m) => ({ default: m.OrpheusHealthSection }))
)
const OrpheusAboutSection = lazy(() =>
  import('./settings/OrpheusAboutSection').then((m) => ({ default: m.OrpheusAboutSection }))
)

// ---------------------------------------------------------------------------
// SectionLoader — Suspense fallback while a section chunk loads
// ---------------------------------------------------------------------------

function SectionLoader(): React.JSX.Element {
  return (
    <div className="min-h-[120px]">
      <SettingsSectionSkeleton groups={2} rowsPerGroup={2} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section types
// ---------------------------------------------------------------------------

export type SectionId =
  | 'claude-general'
  | 'claude-display'
  | 'claude-permissions'
  | 'claude-auth'
  | 'claude-memory'
  | 'claude-tools'
  | 'claude-slash-commands'
  | 'claude-subagents'
  | 'claude-hooks'
  | 'claude-developer'
  | 'claude-about'
  | 'orpheus-appearance'
  | 'orpheus-sidebar'
  | 'orpheus-terminal'
  | 'orpheus-window'
  | 'orpheus-notifications'
  | 'orpheus-workspaces'
  | 'orpheus-keep-awake'
  | 'orpheus-updates'
  | 'orpheus-status'
  | 'orpheus-footer'
  | 'orpheus-developer'
  | 'orpheus-diagnostics'
  | 'orpheus-health'
  | 'orpheus-about'

interface SectionDef {
  id: SectionId
  label: string
  icon: Icon
  Component: React.ComponentType
}

interface SectionGroup {
  label: string
  sections: SectionDef[]
}

const GROUPS: SectionGroup[] = [
  {
    label: 'Orpheus',
    sections: [
      // First entry is the default landing section — Orpheus → General.
      // (Keeps the existing 'orpheus-appearance' id so the searchIndex and
      //  any deep-link slugs continue resolving.)
      {
        id: 'orpheus-appearance',
        label: 'General',
        icon: Gear,
        Component: OrpheusAppearanceSection
      },
      {
        id: 'orpheus-sidebar',
        label: 'Sidebar',
        icon: SidebarSimple,
        Component: OrpheusSidebarSection
      },
      {
        id: 'orpheus-terminal',
        label: 'Terminal',
        icon: Terminal,
        Component: OrpheusTerminalSection
      },
      { id: 'orpheus-window', label: 'Window', icon: AppWindow, Component: OrpheusWindowSection },
      {
        id: 'orpheus-notifications',
        label: 'Notifications',
        icon: Bell,
        Component: OrpheusNotificationsSection
      },
      {
        id: 'orpheus-workspaces',
        label: 'Workspaces',
        icon: Stack,
        Component: OrpheusWorkspacesSection
      },
      {
        id: 'orpheus-keep-awake',
        label: 'Keep Awake',
        icon: Coffee,
        Component: OrpheusKeepAwakeSection
      },
      {
        id: 'orpheus-updates',
        label: 'Updates',
        icon: ArrowsClockwise,
        Component: OrpheusUpdatesSection
      },
      {
        id: 'orpheus-status',
        label: 'Service status',
        icon: Pulse,
        Component: OrpheusStatusSection
      },
      {
        id: 'orpheus-footer',
        label: 'Quick Actions',
        icon: Lightning,
        Component: OrpheusFooterSection
      },
      {
        id: 'orpheus-developer',
        label: 'Developer',
        icon: Code,
        Component: OrpheusDeveloperSection
      },
      {
        id: 'orpheus-diagnostics',
        label: 'Diagnostics',
        icon: Pulse,
        Component: OrpheusDiagnosticsSection
      },
      {
        id: 'orpheus-health',
        label: 'Health',
        icon: FirstAidKit,
        Component: OrpheusHealthSection
      },
      { id: 'orpheus-about', label: 'About Orpheus', icon: Info, Component: OrpheusAboutSection }
    ]
  },
  {
    label: 'Claude',
    sections: [
      { id: 'claude-general', label: 'General', icon: Gear, Component: ClaudeGeneralSection },
      { id: 'claude-display', label: 'Display', icon: Monitor, Component: ClaudeDisplaySection },
      {
        id: 'claude-permissions',
        label: 'Permissions',
        icon: ShieldCheck,
        Component: ClaudePermissionsSection
      },
      { id: 'claude-auth', label: 'Authentication', icon: Key, Component: ClaudeAuthSection },
      {
        id: 'claude-memory',
        label: 'Memory & Context',
        icon: Brain,
        Component: ClaudeMemorySection
      },
      { id: 'claude-tools', label: 'Tools', icon: Wrench, Component: ClaudeToolsSection },
      {
        id: 'claude-slash-commands',
        label: 'Slash commands',
        icon: Command,
        Component: ClaudeSlashCommandsSection
      },
      {
        id: 'claude-subagents',
        label: 'Subagents',
        icon: Robot,
        Component: ClaudeSubagentsSection
      },
      { id: 'claude-hooks', label: 'Hooks', icon: FlowArrow, Component: ClaudeHooksSection },
      { id: 'claude-developer', label: 'Developer', icon: Code, Component: ClaudeDeveloperSection },
      { id: 'claude-about', label: 'About Claude', icon: Info, Component: ClaudeAboutSection }
    ]
  }
]

// ---------------------------------------------------------------------------
// SettingsView — two-pane shell: internal nav + section content
// ---------------------------------------------------------------------------

export function SettingsView(): React.JSX.Element {
  // Default to Orpheus → General (the first section in the first group).
  const [activeId, setActiveId] = useState<SectionId>('orpheus-appearance')
  const [query, setQuery] = useState('')
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  const allSections = GROUPS.flatMap((g) => g.sections)
  const active = allSections.find((s) => s.id === activeId) ?? allSections[0]
  const ActiveComponent = active.Component

  const results = query.trim() ? searchSettings(query, SETTINGS_SEARCH_INDEX) : []

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod && e.key === 'f') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
      if (e.key === 'Escape' && document.activeElement === searchInputRef.current) {
        setQuery('')
        searchInputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  useEffect(() => {
    if (!pendingScrollId) return
    let flashTimer: ReturnType<typeof setTimeout> | null = null
    // Defer until after the new section has rendered into the DOM
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(pendingScrollId)
      if (!el) {
        setPendingScrollId(null)
        return
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.setAttribute('data-flash', '1')
      flashTimer = setTimeout(() => {
        el.removeAttribute('data-flash')
      }, 1500)
      setPendingScrollId(null)
    })
    return () => {
      cancelAnimationFrame(raf)
      if (flashTimer !== null) clearTimeout(flashTimer)
    }
  }, [pendingScrollId, activeId])

  function selectResult(result: SettingsSearchResult): void {
    const slug = result.entry.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    const domId = `setting-${slug}`
    setActiveId(result.entry.sectionId)
    setQuery('')
    setPendingScrollId(domId)
  }

  return (
    <div className="flex h-full">
      <nav
        className="w-56 flex-shrink-0 bg-surface-raised border-r border-border-default py-6 overflow-y-auto"
        aria-label="Settings sections"
      >
        <h1 className="text-base font-semibold text-text-primary px-3 mb-3">Settings</h1>

        {/* Search input */}
        <div className="px-3 mb-4">
          <div className="relative">
            <MagnifyingGlass
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
            />
            <input
              ref={searchInputRef}
              type="text"
              aria-label="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings…"
              className="w-full pl-7 pr-3 py-1.5 text-xs bg-surface-overlay border border-border-default rounded-md text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 transition-colors cursor-text"
            />
          </div>
        </div>

        {query.trim() ? (
          <SearchResults results={results} query={query} onSelect={selectResult} />
        ) : (
          <GroupedNav groups={GROUPS} activeId={activeId} onSelect={setActiveId} />
        )}
      </nav>

      <div ref={contentRef} className="flex-1 overflow-y-auto px-8 py-6 min-w-0">
        <Suspense fallback={<SectionLoader />}>
          <ActiveComponent />
        </Suspense>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SearchResults — replaces GroupedNav when query is non-empty
// ---------------------------------------------------------------------------

function HighlightedLabel({ label, query }: { label: string; query: string }): React.JSX.Element {
  const idx = label.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return <span>{label}</span>
  return (
    <span>
      {label.slice(0, idx)}
      <mark className="bg-accent/30 text-text-primary rounded px-0.5 not-italic font-medium">
        {label.slice(idx, idx + query.length)}
      </mark>
      {label.slice(idx + query.length)}
    </span>
  )
}

function SearchResults(props: {
  results: SettingsSearchResult[]
  query: string
  onSelect: (r: SettingsSearchResult) => void
}): React.JSX.Element {
  if (props.results.length === 0) {
    return (
      <div className="px-3 py-4">
        <p className="text-xs text-text-muted">
          No matches for &ldquo;{props.query}&rdquo;. Try shorter, broader terms.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0.5">
      {props.results.map((r) => {
        const key = `${r.entry.sectionId}:${r.entry.settingId}`
        return (
          <button
            type="button"
            key={key}
            onClick={() => props.onSelect(r)}
            className="w-full flex flex-col gap-0.5 px-3 py-2 text-left transition-colors duration-150 cursor-pointer hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40"
          >
            <span className="text-xs text-text-muted leading-none">
              {r.entry.sectionGroup} › {r.entry.sectionLabel}
            </span>
            <span className="text-sm text-text-primary leading-snug">
              <HighlightedLabel label={r.entry.label} query={props.query} />
            </span>
            {r.matchedField === 'mapsTo' && r.matchedText && (
              <code className="text-xs font-mono text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 leading-none self-start">
                {r.matchedText}
              </code>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// GroupedNav — renders group labels + section buttons with a divider between groups
// ---------------------------------------------------------------------------

function GroupedNav(props: {
  groups: SectionGroup[]
  activeId: SectionId
  onSelect: (id: SectionId) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      {props.groups.map((group, groupIdx) => (
        <div key={group.label}>
          {/* Divider between groups */}
          {groupIdx > 0 && <div className="my-3 mx-3 border-t border-border-default/60" />}
          {/* Group label */}
          <p className="px-3 mb-1 text-xs font-semibold uppercase tracking-widest text-text-muted select-none">
            {group.label}
          </p>
          {/* Section items — no mx-* so active bg stretches full nav width */}
          {group.sections.map((s) => {
            const isActive = s.id === props.activeId
            const SectionIcon = s.icon
            return (
              <button
                type="button"
                key={s.id}
                onClick={() => props.onSelect(s.id)}
                aria-current={isActive ? 'page' : undefined}
                className={[
                  'w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors duration-150 cursor-pointer',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40',
                  isActive
                    ? 'bg-accent/15 text-text-primary font-medium'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
                ].join(' ')}
              >
                <SectionIcon
                  size={15}
                  weight={isActive ? 'fill' : 'regular'}
                  className={isActive ? 'text-accent' : ''}
                />
                <span>{s.label}</span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
