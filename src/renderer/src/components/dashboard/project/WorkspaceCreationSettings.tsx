import { useEffect, useState } from 'react'
import type React from 'react'
import { SettingRow, Toggle } from '../settings/primitives'

// ---------------------------------------------------------------------------
// WorkspaceCreationSettings — per-project "Workspace creation" toggles
//
// Reads the EFFECTIVE config (global ⊕ project .orpheus/config.yml) and lets
// the user write a project-level override. Rendered inside SettingsDrawer.
// ---------------------------------------------------------------------------

type WorkspacesConfig = { allowLocal: boolean; allowWorktree: boolean }

interface WorkspaceCreationSettingsProps {
  projectId: string
}

export function WorkspaceCreationSettings({
  projectId
}: WorkspaceCreationSettingsProps): React.JSX.Element {
  const [config, setConfig] = useState<WorkspacesConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.orpheusConfig
      .get(projectId)
      .then((c) => {
        if (!cancelled) setConfig(c)
      })
      .catch((err) => console.error('[workspace-creation-settings] failed to load', err))
    return () => {
      cancelled = true
    }
  }, [projectId])

  function toggle(key: keyof WorkspacesConfig, value: boolean): void {
    window.api.orpheusConfig
      .setOverride(projectId, { [key]: value })
      .then((updated) => setConfig(updated))
      .catch((err) => {
        console.error('[workspace-creation-settings] setOverride failed; refetching', err)
        window.api.orpheusConfig
          .get(projectId)
          .then((c) => setConfig(c))
          .catch(console.error)
      })
  }

  return (
    <section className="flex flex-col mt-4 border-t border-border-default/40">
      <header className="px-4 pt-5 pb-2">
        <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">
          Workspace creation
        </span>
      </header>
      <p className="px-4 pb-3 text-xs text-text-muted">
        Controls which options appear in the + menu. Changes write{' '}
        <code className="font-mono">.orpheus/config.yml</code> in the project directory.
      </p>
      <div className={['px-5', config === null ? 'opacity-50 pointer-events-none' : ''].join(' ')}>
        <SettingRow
          label="Allow local workspaces"
          description="When enabled, the + menu offers starting a workspace directly in the project directory."
        >
          <Toggle
            ariaLabel="Allow local workspaces"
            value={config?.allowLocal ?? true}
            onChange={(v) => toggle('allowLocal', v)}
          />
        </SettingRow>
        <SettingRow
          label="Allow worktree workspaces"
          description="When enabled, the + menu offers creating a git worktree for isolated parallel work."
        >
          <Toggle
            ariaLabel="Allow worktree workspaces"
            value={config?.allowWorktree ?? true}
            onChange={(v) => toggle('allowWorktree', v)}
          />
        </SettingRow>
      </div>
    </section>
  )
}
