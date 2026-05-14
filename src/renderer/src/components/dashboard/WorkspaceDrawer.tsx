import { useEffect, useState } from 'react'
import type React from 'react'
import { X } from '@phosphor-icons/react'
import { SettingRow, SegmentedControl } from './settings/primitives'
import { ActivityIndicator } from './ActivityIndicator'
import {
  CLAUDE_MODEL_OPTIONS,
  type WorkspaceRecord,
  type WorkspaceStatus,
  type ClaudeWorkspaceSettings,
  type ClaudeWorkspaceSettingsOverrides,
  type ClaudePermissionMode,
  type ClaudeEffort
} from '@shared/types'

// ---------------------------------------------------------------------------
// Status tab — read-only auto-derived activity display
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<WorkspaceStatus, string | null> = {
  in_progress: 'working',
  awaiting_input: 'ready for your next message',
  attention: 'waiting on you',
  idle: 'not running',
  archived: null
}

const STATUS_COLORS: Partial<Record<WorkspaceStatus, string>> = {
  in_progress: 'text-accent',
  awaiting_input: 'text-emerald-400',
  attention: 'text-amber-400',
  idle: 'text-text-muted'
}

interface StatusTabProps {
  activity: WorkspaceStatus
  workspaceId: string
}

function StatusTab({ activity, workspaceId }: StatusTabProps): React.JSX.Element {
  const label = STATUS_LABELS[activity]
  const color = STATUS_COLORS[activity] ?? 'text-text-muted'
  const canReset = activity === 'in_progress' || activity === 'attention'

  function handleReset(): void {
    window.api.workspaces.resetActivity(workspaceId).catch((err) => {
      console.error('[drawer] resetActivity failed', err)
    })
  }

  return (
    <div className="flex flex-col gap-2 p-4">
      <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">
        Activity
      </span>
      {label !== null ? (
        <p className="text-xs text-text-muted flex items-center gap-1.5">
          <ActivityIndicator status={activity} />
          Claude is{' '}
          <span className={color}>{label}</span>
        </p>
      ) : (
        <p className="text-xs text-text-muted">Workspace is archived.</p>
      )}
      {canReset && (
        <button
          type="button"
          onClick={handleReset}
          className="self-start mt-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-surface-overlay border border-border-default hover:border-border-hover text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
          title="Use this if Claude was interrupted (Ctrl-C / Esc) and the indicator is stuck."
        >
          Mark as ready
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overrides tab (migrated from WorkspaceOverridesPopover)
// ---------------------------------------------------------------------------

const MODEL_OPTIONS = [
  { value: 'default', label: 'Default' },
  ...CLAUDE_MODEL_OPTIONS
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

type ModelOption = (typeof MODEL_OPTIONS)[number]['value']
type PermissionOption = (typeof PERMISSION_OPTIONS)[number]['value']
type EffortOption = (typeof EFFORT_OPTIONS)[number]['value']

interface OverridesTabProps {
  workspaceId: string
}

function OverridesTab({ workspaceId }: OverridesTabProps): React.JSX.Element {
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
      .catch((err) => console.error('[WorkspaceDrawer] overrides load failed', err))
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  function patch(update: ClaudeWorkspaceSettingsOverrides): void {
    const next: ClaudeWorkspaceSettingsOverrides = { ...localOverrides }
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) {
        delete next[key as keyof ClaudeWorkspaceSettingsOverrides]
      } else {
        ;(next as Record<string, unknown>)[key] = value
      }
    }
    setLocalOverrides(next)
    window.api.claudeWorkspaceSettings.update(workspaceId, update).catch((err) => {
      console.error('[WorkspaceDrawer] overrides update failed; refetching', err)
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
      ? MODEL_OPTIONS.some((o) => o.value === localOverrides.model)
        ? (localOverrides.model as ModelOption)
        : 'default'
      : 'default'

  const permissionValue: PermissionOption =
    localOverrides.permissionMode !== undefined
      ? (localOverrides.permissionMode as PermissionOption)
      : 'default'

  const effortValue: EffortOption =
    localOverrides.effort !== undefined ? (localOverrides.effort as EffortOption) : 'default'

  return (
    <div className="flex flex-col">
      <div className="px-4 pt-3 pb-1">
        <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">
          Workspace overrides
        </span>
      </div>

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

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

export interface WorkspaceDrawerProps {
  workspace: WorkspaceRecord
  activity: WorkspaceStatus
  activeTab: 'status' | 'overrides'
  onTabChange: (tab: 'status' | 'overrides') => void
  onClose: () => void
}

export function WorkspaceDrawer({
  workspace,
  activity,
  activeTab,
  onTabChange,
  onClose
}: WorkspaceDrawerProps): React.JSX.Element {
  return (
    <div className="flex flex-col h-full w-full">
      {/* Drawer top bar: tabs + close */}
      <div className="h-8 flex items-center gap-0.5 px-2 border-b border-border-default flex-shrink-0">
        <button
          onClick={() => onTabChange('status')}
          className={[
            'h-6 px-2.5 text-[11px] font-medium rounded transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
            activeTab === 'status'
              ? 'bg-surface-overlay text-text-primary'
              : 'text-text-muted hover:text-text-primary'
          ].join(' ')}
        >
          Status
        </button>
        <button
          onClick={() => onTabChange('overrides')}
          className={[
            'h-6 px-2.5 text-[11px] font-medium rounded transition-colors duration-150',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
            activeTab === 'overrides'
              ? 'bg-surface-overlay text-text-primary'
              : 'text-text-muted hover:text-text-primary'
          ].join(' ')}
        >
          Overrides
        </button>
        <button
          onClick={onClose}
          className="ml-auto w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          aria-label="Close drawer"
        >
          <X size={11} weight="bold" />
        </button>
      </div>

      {/* Drawer body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {activeTab === 'status' ? (
          <StatusTab activity={activity} workspaceId={workspace.id} />
        ) : (
          <OverridesTab workspaceId={workspace.id} />
        )}
      </div>
    </div>
  )
}
