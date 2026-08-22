import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { Icon } from '@phosphor-icons/react'
import { useHarnessList } from '@/lib/harnessStore'
import {
  filterSectionGroup,
  isSectionIdApplicable,
  resolveActiveSectionId
} from '@shared/harness/settingsSectionGating'
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
  Terminal,
  Stack,
  FirstAidKit,
  Coffee,
  SquaresFour,
  Compass,
  ShareNetwork,
  EyeSlash,
  Clock,
  Database,
  Image,
  Sliders
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
const OrpheusIconPackSection = lazy(() =>
  import('./settings/OrpheusIconPackSection').then((m) => ({
    default: m.OrpheusIconPackSection
  }))
)
const OrpheusSidebarSection = lazy(() =>
  import('./settings/OrpheusSidebarSection').then((m) => ({ default: m.OrpheusSidebarSection }))
)
const OrpheusTerminalSection = lazy(() =>
  import('./settings/OrpheusTerminalSection').then((m) => ({ default: m.OrpheusTerminalSection }))
)
const OrpheusWorkbenchSection = lazy(() =>
  import('./settings/OrpheusWorkbenchSection').then((m) => ({
    default: m.OrpheusWorkbenchSection
  }))
)
const OrpheusAgentToolsSection = lazy(() =>
  import('./settings/OrpheusAgentToolsSection').then((m) => ({
    default: m.OrpheusAgentToolsSection
  }))
)
const OrpheusAutomationsSection = lazy(() =>
  import('./settings/OrpheusAutomationsSection').then((m) => ({
    default: m.OrpheusAutomationsSection
  }))
)
const OrpheusNavigationSection = lazy(() =>
  import('./settings/OrpheusNavigationSection').then((m) => ({
    default: m.OrpheusNavigationSection
  }))
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
const OrpheusPrivacySection = lazy(() =>
  import('./settings/OrpheusPrivacySection').then((m) => ({ default: m.OrpheusPrivacySection }))
)
const OrpheusUpdatesSection = lazy(() =>
  import('./settings/OrpheusUpdatesSection').then((m) => ({ default: m.OrpheusUpdatesSection }))
)
const OrpheusProdImportSection = lazy(() =>
  import('./settings/OrpheusProdImportSection').then((m) => ({
    default: m.OrpheusProdImportSection
  }))
)
const OrpheusModelRoutingSection = lazy(() =>
  import('./settings/OrpheusModelRoutingSection').then((m) => ({
    default: m.OrpheusModelRoutingSection
  }))
)
const HarnessSection = lazy(() =>
  import('./settings/HarnessSection').then((m) => ({ default: m.HarnessSection }))
)
const OrpheusStatusSection = lazy(() =>
  import('./settings/OrpheusStatusSection').then((m) => ({ default: m.OrpheusStatusSection }))
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
  | 'orpheus-icon-pack'
  | 'orpheus-sidebar'
  | 'orpheus-navigation'
  | 'orpheus-terminal'
  | 'orpheus-workbench'
  | 'orpheus-agent-tools'
  | 'orpheus-automations'
  | 'orpheus-window'
  | 'orpheus-notifications'
  | 'orpheus-workspaces'
  | 'orpheus-keep-awake'
  | 'orpheus-privacy'
  | 'orpheus-updates'
  | 'orpheus-prod-import'
  | 'orpheus-model-routing'
  | 'orpheus-harness'
  | 'orpheus-status'
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
  /** Whether this group's sections are harness-owned and therefore subject
   *  to settingsSectionGating.ts's registered-harness filter (support-
   *  multi-harness) — true for Claude's group, false for Orpheus's
   *  app-level group, which always renders every section regardless of
   *  which harness(es) are registered. See settingsSectionGating.ts's own
   *  header for why this is a per-GROUP structural flag rather than an
   *  id-naming-convention check. */
  gated: boolean
}

const GROUPS: SectionGroup[] = [
  {
    label: 'Orpheus',
    gated: false,
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
        id: 'orpheus-icon-pack',
        label: 'App Icon',
        icon: Image,
        Component: OrpheusIconPackSection
      },
      {
        id: 'orpheus-sidebar',
        label: 'Sidebar',
        icon: SidebarSimple,
        Component: OrpheusSidebarSection
      },
      {
        id: 'orpheus-navigation',
        label: 'Navigation',
        icon: Compass,
        Component: OrpheusNavigationSection
      },
      {
        id: 'orpheus-terminal',
        label: 'Terminal',
        icon: Terminal,
        Component: OrpheusTerminalSection
      },
      {
        id: 'orpheus-workbench',
        label: 'Workbench',
        icon: SquaresFour,
        Component: OrpheusWorkbenchSection
      },
      {
        id: 'orpheus-agent-tools',
        label: 'Agent Tools',
        icon: Wrench,
        Component: OrpheusAgentToolsSection
      },
      {
        id: 'orpheus-automations',
        label: 'Automations',
        icon: Clock,
        Component: OrpheusAutomationsSection
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
        id: 'orpheus-privacy',
        label: 'Privacy',
        icon: EyeSlash,
        Component: OrpheusPrivacySection
      },
      {
        id: 'orpheus-updates',
        label: 'Updates',
        icon: ArrowsClockwise,
        Component: OrpheusUpdatesSection
      },
      // Nightly-only: lets a nightly build pull a one-way, read-only copy of
      // the user's real production data in for testing. Never shown in dev,
      // worktree, or production builds — see OrpheusProdImportSection.tsx's
      // header comment for why this mirrors OrpheusUpdatesSection's dev-only
      // debug seam in the opposite direction.
      ...(__ORPHEUS_MODE__ === 'nightly'
        ? [
            {
              id: 'orpheus-prod-import' as const,
              label: 'Import Production Data',
              icon: Database,
              Component: OrpheusProdImportSection
            }
          ]
        : []),
      {
        id: 'orpheus-model-routing',
        label: 'Model Routing',
        icon: ShareNetwork,
        Component: OrpheusModelRoutingSection
      },
      {
        id: 'orpheus-harness',
        label: 'Harness',
        icon: Sliders,
        Component: HarnessSection
      },
      {
        id: 'orpheus-status',
        label: 'Service status',
        icon: Pulse,
        Component: OrpheusStatusSection
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
    gated: true,
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

export function SettingsView({ section }: { section?: SectionId }): React.JSX.Element {
  // Default to Orpheus → General (the first section in the first group), unless a
  // deep-link target section was supplied (e.g. opening directly on Updates).
  const [activeId, setActiveId] = useState<SectionId>(section ?? 'orpheus-appearance')
  const [query, setQuery] = useState('')
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  // Harness capability gating (support-multi-harness) — hides a group whose
  // sections no REGISTERED harness declares (e.g. the 11 claude-* sections
  // for a harness that doesn't use Claude's own settings.json shape — see
  // settingsSectionGating.ts's header for the full "why the whole group,
  // and why gated on the REGISTERED set rather than any single active
  // harness" rationale). `harnesses` defaults to `[]` while harness:list is
  // still loading — filterSectionGroup's own fail-open default (an empty
  // `harnesses` array) means every section shows during that window, so
  // there is no flash of a truncated nav before the real list resolves.
  const { harnesses } = useHarnessList()
  const visibleGroups = useMemo(() => {
    // NOT deriving the group LABEL from HarnessSummary.label here, despite
    // that being the mechanically "more correct" long-term shape (GROUPS
    // itself is still a hand-authored, harness-agnostic-in-name structure —
    // a real per-harness GROUPS build is a bigger change than this unit's
    // scope). Concretely: Claude's real descriptor label is 'Claude Code'
    // (registry.ts), but GROUPS' own hardcoded group label is the shorter
    // 'Claude' — deriving the label now would SILENTLY change that string
    // for the only registered harness today, directly contradicting "the
    // settings page must look and behave EXACTLY as today" with only
    // Claude registered. Filtering which SECTIONS show is this unit's
    // actual bug fix; renaming a group label with no second harness yet to
    // justify the rename is a cosmetic change nothing asked for and the
    // regression net explicitly forbids. Left as GROUPS' own static label;
    // revisit when a second harness's group actually needs a name.
    return GROUPS.map((group) => {
      const { visibleSections } = filterSectionGroup(
        group.sections,
        (s) => s.id,
        harnesses,
        group.gated
      )
      return { ...group, sections: visibleSections }
    }).filter((group) => group.sections.length > 0)
  }, [harnesses])

  const allSections = GROUPS.flatMap((g) => g.sections)
  const visibleActiveId = resolveActiveSectionId(activeId, visibleGroups, (s) => s.id) as SectionId
  const active = allSections.find((s) => s.id === visibleActiveId) ?? allSections[0]
  const ActiveComponent = active.Component

  // Filter the search INDEX (not the results) by the same section gate —
  // otherwise a search could surface a result pointing at a section
  // GroupedNav has already hidden (~106 of 163 index entries are tagged
  // sectionGroup: 'Claude', all reachable through claude-* sectionIds).
  // Filtering the index rather than post-filtering results also means the
  // matcher's own dedup/scoring never considers a hidden entry to begin
  // with. Each SettingsSearchEntry already carries `sectionGroup: 'Claude'
  // | 'Orpheus'` — the SAME per-group gated/ungated split GROUPS' own
  // `gated` flag encodes, checked directly rather than re-deriving it from
  // the section id (which id-based lookup this file's redesign specifically
  // avoids — see settingsSectionGating.ts's header). `useMemo` keyed on
  // `harnesses` (not `query`) — cheap relative to the search itself and
  // avoids recomputing on every keystroke.
  const searchableIndex = useMemo(
    () =>
      SETTINGS_SEARCH_INDEX.filter(
        (e) => e.sectionGroup !== 'Claude' || isSectionIdApplicable(e.sectionId, harnesses)
      ),
    [harnesses]
  )
  const results = query.trim() ? searchSettings(query, searchableIndex) : []

  // Re-navigate when the deep-link target changes (e.g. the sidebar update
  // control is clicked again while Settings is already open). Mirroring the
  // incoming prop into local nav state is the intended behavior here.
  /* eslint-disable react-hooks/set-state-in-effect -- deep-link prop mirrored into local nav state */
  useEffect(() => {
    if (section) setActiveId(section)
  }, [section])
  /* eslint-enable react-hooks/set-state-in-effect */

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
          <GroupedNav groups={visibleGroups} activeId={visibleActiveId} onSelect={setActiveId} />
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
