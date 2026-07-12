import type React from 'react'
import type { AppUiStatePatch } from '@shared/types'
import { SettingRow, Toggle, SectionTitle, Eyebrow } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { useUiState, updateUiState } from '../../../lib/uiStateStore'

// ---------------------------------------------------------------------------
// OrpheusWorkbenchSection — settings for the Workbench pane (Files editor,
// and future Workbench panes e.g. Pierre display settings). Keep each pane's
// settings in its own Eyebrow group so this section can grow without
// reshuffling.
// ---------------------------------------------------------------------------

export function OrpheusWorkbenchSection(): React.JSX.Element {
  const uiState = useUiState()

  function patch(p: AppUiStatePatch): void {
    updateUiState(p)
  }

  if (!uiState) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <SectionTitle>Workbench</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Settings for the Workbench panes — Files editor and more.
          </p>
        </div>
        <SettingsSectionSkeleton groups={1} rowsPerGroup={1} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Workbench</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Settings for the Workbench panes — Files editor and more.
        </p>
      </div>

      {/* Files editor */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Files editor</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Auto-save edits"
            description="In the Workbench Files tab's Editor mode, write changes to disk automatically after ~1s of idle. When off, save manually with ⌘S."
          >
            <Toggle
              value={uiState.filesAutoSave ?? false}
              onChange={(v) => patch({ filesAutoSave: v })}
              ariaLabel="Auto-save file edits"
            />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
