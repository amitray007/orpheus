import type React from 'react'
import type { AppUiStatePatch } from '@shared/types'
import { SettingRow, SegmentedControl, Toggle, SectionTitle } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { useUiState, updateUiState } from '../../../lib/uiStateStore'

// ---------------------------------------------------------------------------
// OrpheusNavigationSection — Open-at-launch surface preference. Controls
// which top-level surface (Dashboard / Projects / Panes) the app opens on
// startup (see AppUiState.defaultSurface / app_ui_state.default_surface).
// ---------------------------------------------------------------------------

export function OrpheusNavigationSection(): React.JSX.Element {
  const uiState = useUiState()

  function patch(p: AppUiStatePatch): void {
    updateUiState(p)
  }

  if (!uiState) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <SectionTitle>Navigation</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Choose which surface opens when you launch Orpheus.
          </p>
        </div>
        <SettingsSectionSkeleton groups={1} rowsPerGroup={2} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Navigation</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Choose which surface opens when you launch Orpheus.
        </p>
      </div>

      <section className="flex flex-col">
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Open at launch"
            description="Choose which surface opens when you launch Orpheus."
          >
            <SegmentedControl<'dashboard' | 'projects' | 'panes'>
              ariaLabel="Open at launch"
              options={[
                { value: 'dashboard', label: 'Dashboard' },
                { value: 'projects', label: 'Projects' },
                { value: 'panes', label: 'Panes' }
              ]}
              value={uiState.defaultSurface ?? 'projects'}
              onChange={(v) => patch({ defaultSurface: v })}
            />
          </SettingRow>
          {/* Projects surface — optional Workspaces board (kanban), off by
              default. When on, a small "Workspaces" board button appears at
              the top of the Projects surface to switch into the retained
              WorkspacesView kanban (see MainContent's sessions branch). */}
          <SettingRow
            label="Show Workspaces board"
            description="Show the optional Workspaces board (kanban) on the Projects surface."
          >
            <Toggle
              value={uiState.showWorkspacesBoard ?? false}
              onChange={(v) => patch({ showWorkspacesBoard: v })}
              ariaLabel="Show Workspaces board"
            />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
