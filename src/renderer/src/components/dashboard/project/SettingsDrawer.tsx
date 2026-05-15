import { useEffect, useState } from 'react'
import type React from 'react'
import { X } from '@phosphor-icons/react'
import {
  CLAUDE_MODEL_OPTIONS,
  type ClaudeEffort,
  type ClaudePermissionMode,
  type ClaudeProjectSettings,
  type ClaudeProjectSettingsOverrides
} from '@shared/types'
import { SettingRow, SegmentedControl } from '../settings/primitives'

// ---------------------------------------------------------------------------
// Per-project settings drawer
//
// v1 surfaces only the three knobs that are wired through composeClaudeLaunch
// today (model / permission mode / effort). The fuller Claude-section parity
// (hooks, tools, MCP, subagents, slash commands, memory, display) lands later
// once the section components are made scope-agnostic so they can be reused
// across global + project + workspace scopes.
// ---------------------------------------------------------------------------

interface SettingsDrawerProps {
  projectId: string
  projectName: string
  open: boolean
  onClose: () => void
}

type ModelValue = '__global__' | (typeof CLAUDE_MODEL_OPTIONS)[number]['value']
type PermissionValue = '__global__' | ClaudePermissionMode
type EffortValue = '__global__' | ClaudeEffort

export function SettingsDrawer({
  projectId,
  projectName,
  open,
  onClose
}: SettingsDrawerProps): React.JSX.Element | null {
  const [settings, setSettings] = useState<ClaudeProjectSettings | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    window.api.claudeProjectSettings
      .get(projectId)
      .then((s) => {
        if (!cancelled) setSettings(s)
      })
      .catch((err) => console.error('[settings-drawer] failed to load', err))
    return () => {
      cancelled = true
    }
  }, [open, projectId])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  function patch(p: ClaudeProjectSettingsOverrides): void {
    if (!settings) return
    const next: ClaudeProjectSettingsOverrides = { ...settings.overrides }
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) delete next[k as keyof ClaudeProjectSettingsOverrides]
      else (next as Record<string, unknown>)[k] = v
    }
    setSettings({ ...settings, overrides: next })
    window.api.claudeProjectSettings.update(projectId, p).catch((err) => {
      console.error('[settings-drawer] update failed, refetching', err)
      window.api.claudeProjectSettings.get(projectId).then(setSettings).catch(console.error)
    })
  }

  if (!open) return null

  const overrides = settings?.overrides ?? {}
  const overrideCount = Object.keys(overrides).length

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={`Project settings — ${projectName}`}
    >
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 w-[460px] max-w-[90vw] h-full bg-surface-base border-l border-border-default shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-default">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text-primary truncate">Project settings</h2>
            <p className="text-xs text-text-muted truncate">
              {projectName}
              {overrideCount > 0 && (
                <span className="text-accent ml-2">
                  · {overrideCount} override{overrideCount === 1 ? '' : 's'}
                </span>
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors cursor-pointer"
          >
            <X size={14} weight="bold" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5">
          {settings === null ? (
            <div className="py-10 text-center text-sm text-text-muted">Loading…</div>
          ) : (
            <>
              <SettingRow
                label="Model"
                description="Override the global default model for this project."
              >
                <SegmentedControl<ModelValue>
                  ariaLabel="Model override"
                  options={[{ value: '__global__', label: '(global)' }, ...CLAUDE_MODEL_OPTIONS]}
                  value={(overrides.model ?? '__global__') as ModelValue}
                  onChange={(v) => patch({ model: v === '__global__' ? undefined : v })}
                />
              </SettingRow>

              <SettingRow
                label="Permission mode"
                description="Override the global permission mode for this project."
              >
                <SegmentedControl<PermissionValue>
                  ariaLabel="Permission mode override"
                  options={[
                    { value: '__global__', label: '(global)' },
                    { value: 'default', label: 'Default' },
                    { value: 'acceptEdits', label: 'Accept edits' },
                    { value: 'plan', label: 'Plan' },
                    { value: 'bypassPermissions', label: 'Bypass' }
                  ]}
                  value={(overrides.permissionMode ?? '__global__') as PermissionValue}
                  onChange={(v) =>
                    patch({
                      permissionMode: v === '__global__' ? undefined : v
                    })
                  }
                />
              </SettingRow>

              <SettingRow
                label="Effort"
                description="Override the global thinking effort for this project."
              >
                <SegmentedControl<EffortValue>
                  ariaLabel="Effort override"
                  options={[
                    { value: '__global__', label: '(global)' },
                    { value: 'auto', label: 'Auto' },
                    { value: 'low', label: 'Low' },
                    { value: 'medium', label: 'Med' },
                    { value: 'high', label: 'High' },
                    { value: 'xhigh', label: 'XH' },
                    { value: 'max', label: 'Max' }
                  ]}
                  value={(overrides.effort ?? '__global__') as EffortValue}
                  onChange={(v) => patch({ effort: v === '__global__' ? undefined : v })}
                />
              </SettingRow>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
