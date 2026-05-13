import { useState } from 'react'
import type React from 'react'
import type { Icon } from '@phosphor-icons/react'
import {
  Gear,
  Monitor,
  ShieldCheck,
  Key,
  Brain,
  Wrench,
  FlowArrow,
  Code,
  Info,
  Palette,
  SidebarSimple,
  AppWindow,
  ArrowsClockwise,
  Command,
  Robot
} from '@phosphor-icons/react'

import { ClaudeGeneralSection } from './settings/ClaudeGeneralSection'
import { ClaudeDisplaySection } from './settings/ClaudeDisplaySection'
import { ClaudePermissionsSection } from './settings/ClaudePermissionsSection'
import { ClaudeAuthSection } from './settings/ClaudeAuthSection'
import { ClaudeMemorySection } from './settings/ClaudeMemorySection'
import { ClaudeToolsSection } from './settings/ClaudeToolsSection'
import { ClaudeSlashCommandsSection } from './settings/ClaudeSlashCommandsSection'
import { ClaudeSubagentsSection } from './settings/ClaudeSubagentsSection'
import { ClaudeHooksSection } from './settings/ClaudeHooksSection'
import { ClaudeDeveloperSection } from './settings/ClaudeDeveloperSection'
import { ClaudeAboutSection } from './settings/ClaudeAboutSection'
import { OrpheusAppearanceSection } from './settings/OrpheusAppearanceSection'
import { OrpheusSidebarSection } from './settings/OrpheusSidebarSection'
import { OrpheusWindowSection } from './settings/OrpheusWindowSection'
import { OrpheusUpdatesSection } from './settings/OrpheusUpdatesSection'
import { OrpheusAboutSection } from './settings/OrpheusAboutSection'

// ---------------------------------------------------------------------------
// Section types
// ---------------------------------------------------------------------------

type SectionId =
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
  | 'orpheus-window'
  | 'orpheus-updates'
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
    label: 'Claude',
    sections: [
      { id: 'claude-general',     label: 'General',          icon: Gear,        Component: ClaudeGeneralSection },
      { id: 'claude-display',     label: 'Display',          icon: Monitor,     Component: ClaudeDisplaySection },
      { id: 'claude-permissions', label: 'Permissions',      icon: ShieldCheck, Component: ClaudePermissionsSection },
      { id: 'claude-auth',        label: 'Authentication',   icon: Key,         Component: ClaudeAuthSection },
      { id: 'claude-memory',      label: 'Memory & Context', icon: Brain,       Component: ClaudeMemorySection },
      { id: 'claude-tools',          label: 'Tools',          icon: Wrench,   Component: ClaudeToolsSection },
      { id: 'claude-slash-commands', label: 'Slash commands', icon: Command,  Component: ClaudeSlashCommandsSection },
      { id: 'claude-subagents',      label: 'Subagents',      icon: Robot,    Component: ClaudeSubagentsSection },
      { id: 'claude-hooks',          label: 'Hooks',          icon: FlowArrow, Component: ClaudeHooksSection },
      { id: 'claude-developer',   label: 'Developer',        icon: Code,        Component: ClaudeDeveloperSection },
      { id: 'claude-about',       label: 'About Claude',     icon: Info,        Component: ClaudeAboutSection }
    ]
  },
  {
    label: 'Orpheus',
    sections: [
      { id: 'orpheus-appearance', label: 'Appearance',       icon: Palette,          Component: OrpheusAppearanceSection },
      { id: 'orpheus-sidebar',    label: 'Sidebar',          icon: SidebarSimple,    Component: OrpheusSidebarSection },
      { id: 'orpheus-window',     label: 'Window',           icon: AppWindow,        Component: OrpheusWindowSection },
      { id: 'orpheus-updates',    label: 'Updates',          icon: ArrowsClockwise,  Component: OrpheusUpdatesSection },
      { id: 'orpheus-about',      label: 'About Orpheus',    icon: Info,             Component: OrpheusAboutSection }
    ]
  }
]

// ---------------------------------------------------------------------------
// SettingsView — two-pane shell: internal nav + section content
// ---------------------------------------------------------------------------

export function SettingsView(): React.JSX.Element {
  const [activeId, setActiveId] = useState<SectionId>('claude-general')

  const allSections = GROUPS.flatMap((g) => g.sections)
  const active = allSections.find((s) => s.id === activeId) ?? allSections[0]
  const ActiveComponent = active.Component

  return (
    // Parent <main> uses overflow-hidden min-h-0 for the settings view so this
    // flex container fills the whole pane edge-to-edge. Internal nav + content
    // each manage their own scroll.
    <div className="flex h-full">
      <nav
        className="w-56 flex-shrink-0 bg-surface-raised border-r border-border-default py-6 overflow-y-auto"
        aria-label="Settings sections"
      >
        <h1 className="text-base font-semibold text-text-primary px-3 mb-5">Settings</h1>
        <GroupedNav groups={GROUPS} activeId={activeId} onSelect={setActiveId} />
      </nav>

      <div className="flex-1 overflow-y-auto px-8 py-6 min-w-0">
        <ActiveComponent />
      </div>
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
          {groupIdx > 0 && (
            <div className="my-3 mx-3 border-t border-border-default/60" />
          )}
          {/* Group label */}
          <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted select-none">
            {group.label}
          </p>
          {/* Section items — no mx-* so active bg stretches full nav width */}
          {group.sections.map((s) => {
            const isActive = s.id === props.activeId
            const SectionIcon = s.icon
            return (
              <button
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
