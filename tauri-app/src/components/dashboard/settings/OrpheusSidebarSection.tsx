import { useEffect, useState } from 'react'
import type React from 'react'
import type { AppUiState } from '@shared/types'
import { SettingRow, Toggle, NumberInput } from './primitives'

// ---------------------------------------------------------------------------
// OrpheusSidebarSection — sidebar visibility and behavior controls
// ---------------------------------------------------------------------------

function clampSidebarWidth(v: number): number {
  return Math.min(480, Math.max(200, v))
}

export function OrpheusSidebarSection(): React.JSX.Element {
  const [uiState, setUiState] = useState<AppUiState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.uiState
      .get()
      .then((s) => {
        if (!cancelled) setUiState(s)
      })
      .catch((err) => {
        console.error('[settings] failed to load uiState', err)
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  function patch(p: Partial<AppUiState>): void {
    if (!uiState) return
    // Optimistic update
    setUiState({ ...uiState, ...p })
    window.api.uiState.update(p).catch((err) => {
      console.error('[settings] uiState update failed; refetching to reconcile', err)
      window.api.uiState
        .get()
        .then((s) => setUiState(s))
        .catch(console.error)
    })
  }

  if (error) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Sidebar</h2>
          <p className="text-xs text-text-muted mt-1">
            Control sidebar sections, workspace counts, and default expand behavior for new projects.
          </p>
        </div>
        <p className="text-sm text-red-400">Failed to load settings: {error}</p>
      </div>
    )
  }

  if (!uiState) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Sidebar</h2>
          <p className="text-xs text-text-muted mt-1">
            Control sidebar sections, workspace counts, and default expand behavior for new projects.
          </p>
        </div>
        <p className="text-sm text-text-muted">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Sidebar</h2>
        <p className="text-xs text-text-muted mt-1">
          Control sidebar sections, workspace counts, and default expand behavior for new projects.
        </p>
      </div>

      {/* Visibility */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Sections
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Workspace count inline"
            description="Show · N next to project names showing workspace count."
          >
            <Toggle
              value={uiState.workspaceCountInline}
              onChange={(v) => patch({ workspaceCountInline: v })}
              ariaLabel="Workspace count inline"
            />
          </SettingRow>
          <SettingRow
            label="Max archived workspaces"
            description="Older archived workspaces are auto-deleted to stay under this cap."
          >
            <div className="flex items-center gap-1.5">
              <NumberInput
                value={uiState.archivedWorkspaceLimit ?? 20}
                onChange={(v) => patch({ archivedWorkspaceLimit: Math.max(1, v ?? 20) })}
                placeholder="20"
              />
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Expand behavior */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Expand behavior
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Default project expanded"
            description="New projects start with their workspaces visible in the sidebar."
          >
            <Toggle
              value={uiState.defaultProjectExpanded}
              onChange={(v) => patch({ defaultProjectExpanded: v })}
              ariaLabel="Default project expanded"
            />
          </SettingRow>
        </div>
      </section>

      {/* Layout */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Layout
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Sidebar width"
            description="Pixel width when the sidebar is expanded."
          >
            <div className="flex items-center gap-1.5">
              <NumberInput
                value={uiState.sidebarWidth}
                onChange={(v) => patch({ sidebarWidth: clampSidebarWidth(v ?? 256) })}
                placeholder="256"
              />
              <span className="text-xs text-text-muted">px</span>
            </div>
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
