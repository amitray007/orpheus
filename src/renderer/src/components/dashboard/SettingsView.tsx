import { useState } from 'react'
import type React from 'react'
import type { Icon } from '@phosphor-icons/react'
import { Gear, Monitor, ShieldCheck, Key, Brain, Wrench, FlowArrow, Code, Info } from '@phosphor-icons/react'

import { GeneralSection } from './settings/GeneralSection'
import { DisplaySection } from './settings/DisplaySection'
import { PermissionsSection } from './settings/PermissionsSection'
import { AuthSection } from './settings/AuthSection'
import { MemorySection } from './settings/MemorySection'
import { ToolsSection } from './settings/ToolsSection'
import { HooksSection } from './settings/HooksSection'
import { DeveloperSection } from './settings/DeveloperSection'
import { AboutSection } from './settings/AboutSection'

// ---------------------------------------------------------------------------
// Section types
// ---------------------------------------------------------------------------

type SectionId =
  | 'general'
  | 'display'
  | 'permissions'
  | 'auth'
  | 'memory'
  | 'tools'
  | 'hooks'
  | 'developer'
  | 'about'

interface SectionDef {
  id: SectionId
  label: string
  icon: Icon
  group: 1 | 2 | 3 // phase grouping for dividers
  Component: React.ComponentType
}

const SECTIONS: SectionDef[] = [
  { id: 'general',     label: 'General',          icon: Gear,        group: 1, Component: GeneralSection },
  { id: 'display',     label: 'Display',          icon: Monitor,     group: 1, Component: DisplaySection },
  { id: 'permissions', label: 'Permissions',      icon: ShieldCheck, group: 1, Component: PermissionsSection },
  { id: 'auth',        label: 'Authentication',   icon: Key,         group: 1, Component: AuthSection },
  { id: 'memory',      label: 'Memory & Context', icon: Brain,       group: 2, Component: MemorySection },
  { id: 'tools',       label: 'Tools',            icon: Wrench,      group: 2, Component: ToolsSection },
  { id: 'hooks',       label: 'Hooks',            icon: FlowArrow,   group: 3, Component: HooksSection },
  { id: 'developer',   label: 'Developer',        icon: Code,        group: 3, Component: DeveloperSection },
  { id: 'about',       label: 'About',            icon: Info,        group: 3, Component: AboutSection }
]

// ---------------------------------------------------------------------------
// SettingsView — two-pane shell: internal nav + section content
// ---------------------------------------------------------------------------

export function SettingsView(): React.JSX.Element {
  const [activeId, setActiveId] = useState<SectionId>('general')
  const active = SECTIONS.find((s) => s.id === activeId) ?? SECTIONS[0]
  const ActiveComponent = active.Component

  return (
    // -mx-8 -my-6 undoes the parent <main>'s px-8 py-6 padding so the internal
    // sidebar can reach the edges of the content area.
    <div className="flex h-full -mx-8 -my-6">
      {/* Internal nav */}
      <nav
        className="w-56 flex-shrink-0 bg-surface-raised border-r border-border-default px-2 py-6 overflow-y-auto"
        aria-label="Settings sections"
      >
        <h1 className="text-base font-semibold text-text-primary px-3 mb-4">Settings</h1>
        <SectionList sections={SECTIONS} activeId={activeId} onSelect={setActiveId} />
      </nav>

      {/* Section content */}
      <div className="flex-1 overflow-y-auto px-8 py-6 min-w-0">
        <ActiveComponent />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SectionList — nav items with group dividers
// ---------------------------------------------------------------------------

function SectionList(props: {
  sections: SectionDef[]
  activeId: SectionId
  onSelect: (id: SectionId) => void
}): React.JSX.Element {
  const items: React.ReactNode[] = []
  let lastGroup: number | null = null

  for (const s of props.sections) {
    if (lastGroup !== null && s.group !== lastGroup) {
      items.push(
        <div key={`divider-${s.id}`} className="my-2 mx-3 border-t border-border-default/60" />
      )
    }
    lastGroup = s.group
    const isActive = s.id === props.activeId
    const SectionIcon = s.icon
    items.push(
      <button
        key={s.id}
        onClick={() => props.onSelect(s.id)}
        aria-current={isActive ? 'page' : undefined}
        className={[
          'w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors duration-150',
          'focus:outline-none focus:ring-2 focus:ring-accent/50',
          isActive
            ? 'bg-accent/15 text-text-primary font-medium'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
        ].join(' ')}
      >
        <SectionIcon
          size={16}
          weight={isActive ? 'fill' : 'regular'}
          className={isActive ? 'text-accent' : ''}
        />
        <span>{s.label}</span>
      </button>
    )
  }

  return <div className="flex flex-col gap-0.5">{items}</div>
}
