import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { X } from '@phosphor-icons/react'
import { SettingRow, SegmentedControl } from './settings/primitives'
import type { ClaudeWorkspaceSettings, ClaudeWorkspaceSettingsOverrides, ClaudePermissionMode, ClaudeEffort } from '@shared/types'

interface WorkspaceOverridesPopoverProps {
  workspaceId: string
  onClose: () => void
}

const MODEL_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' }
] as const

const PERMISSION_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'acceptEdits', label: 'Accept' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' }
] as const

const EFFORT_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' }
] as const

type ModelOption = typeof MODEL_OPTIONS[number]['value']
type PermissionOption = typeof PERMISSION_OPTIONS[number]['value']
type EffortOption = typeof EFFORT_OPTIONS[number]['value']

export function WorkspaceOverridesPopover({
  workspaceId,
  onClose
}: WorkspaceOverridesPopoverProps): React.JSX.Element {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [settings, setSettings] = useState<ClaudeWorkspaceSettings | null>(null)
  const [localOverrides, setLocalOverrides] = useState<ClaudeWorkspaceSettingsOverrides>({})

  useEffect(() => {
    let cancelled = false
    window.api.claudeWorkspaceSettings
      .get(workspaceId)
      .then((s) => {
        if (!cancelled) {
          setSettings(s)
          setLocalOverrides(s.overrides)
        }
      })
      .catch((err) => console.error('[WorkspaceOverridesPopover] failed to load', err))
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  // Outside-click dismissal
  useEffect(() => {
    function onMouseDown(e: MouseEvent): void {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [onClose])

  // Escape key dismissal
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function patch(update: ClaudeWorkspaceSettingsOverrides): void {
    const next: ClaudeWorkspaceSettingsOverrides = { ...localOverrides }
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) {
        delete next[key as keyof ClaudeWorkspaceSettingsOverrides]
      } else {
        (next as Record<string, unknown>)[key] = value
      }
    }
    setLocalOverrides(next)
    // undefined sentinel tells the main process to delete the key from the stored JSON
    window.api.claudeWorkspaceSettings.update(workspaceId, update).catch((err) => {
      console.error('[WorkspaceOverridesPopover] update failed; refetching', err)
      window.api.claudeWorkspaceSettings
        .get(workspaceId)
        .then((s) => {
          setSettings(s)
          setLocalOverrides(s.overrides)
        })
        .catch(console.error)
    })
  }

  function handleModel(v: ModelOption): void {
    patch({ model: v === 'default' ? undefined : v })
  }

  function handlePermission(v: PermissionOption): void {
    patch({ permissionMode: v === 'default' ? undefined : (v as ClaudePermissionMode) })
  }

  function handleEffort(v: EffortOption): void {
    patch({ effort: v === 'default' ? undefined : (v as ClaudeEffort) })
  }

  function resetAll(): void {
    patch({ model: undefined, permissionMode: undefined, effort: undefined })
  }

  const hasAnyOverride =
    localOverrides.model !== undefined ||
    localOverrides.permissionMode !== undefined ||
    localOverrides.effort !== undefined

  const modelValue: ModelOption =
    localOverrides.model !== undefined
      ? (MODEL_OPTIONS.some((o) => o.value === localOverrides.model)
          ? (localOverrides.model as ModelOption)
          : 'default')
      : 'default'

  const permissionValue: PermissionOption =
    localOverrides.permissionMode !== undefined
      ? (localOverrides.permissionMode as PermissionOption)
      : 'default'

  const effortValue: EffortOption =
    localOverrides.effort !== undefined
      ? (localOverrides.effort as EffortOption)
      : 'default'

  return (
    <div
      ref={popoverRef}
      className="absolute top-full left-0 mt-1 z-50 w-80 rounded-lg border border-border-default bg-surface-raised shadow-xl"
      style={{ minWidth: 320 }}
    >
      {/* Title row */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-border-default/40">
        <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">
          Workspace overrides
        </span>
        <button
          onClick={onClose}
          className="w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          aria-label="Close"
        >
          <X size={11} weight="bold" />
        </button>
      </div>

      {/* Settings rows */}
      <div className={`px-4 ${!settings ? 'opacity-50 pointer-events-none' : ''}`}>
        <SettingRow label="Model">
          <SegmentedControl
            options={MODEL_OPTIONS}
            value={modelValue}
            onChange={handleModel}
            ariaLabel="Workspace model override"
          />
        </SettingRow>
        <SettingRow label="Permission mode">
          <SegmentedControl
            options={PERMISSION_OPTIONS}
            value={permissionValue}
            onChange={handlePermission}
            ariaLabel="Workspace permission mode override"
          />
        </SettingRow>
        <SettingRow label="Effort">
          <SegmentedControl
            options={EFFORT_OPTIONS}
            value={effortValue}
            onChange={handleEffort}
            ariaLabel="Workspace effort override"
          />
        </SettingRow>
      </div>

      {/* Reset link */}
      {hasAnyOverride && (
        <div className="px-4 py-2 border-t border-border-default/40">
          <button
            onClick={resetAll}
            className="text-xs text-text-muted hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
          >
            Reset all overrides
          </button>
        </div>
      )}
    </div>
  )
}
