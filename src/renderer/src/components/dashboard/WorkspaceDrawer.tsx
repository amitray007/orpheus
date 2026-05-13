import { useEffect, useState } from 'react'
import type React from 'react'
import {
  X,
  PlayCircle,
  MagnifyingGlass,
  CheckCircle,
  Archive
} from '@phosphor-icons/react'
import { SettingRow, SegmentedControl } from './settings/primitives'
import type {
  WorkspaceRecord,
  WorkspaceStatus,
  ClaudeWorkspaceSettings,
  ClaudeWorkspaceSettingsOverrides,
  ClaudePermissionMode,
  ClaudeEffort
} from '@shared/types'

// ---------------------------------------------------------------------------
// Status tab
// ---------------------------------------------------------------------------

const STATUS_STAGES: {
  value: WorkspaceStatus
  label: string
  description: string
  icon: React.ElementType
}[] = [
  {
    value: 'in_progress',
    label: 'In Progress',
    description: 'Working on it',
    icon: PlayCircle
  },
  {
    value: 'in_review',
    label: 'In Review',
    description: 'Awaiting review',
    icon: MagnifyingGlass
  },
  {
    value: 'completed',
    label: 'Completed',
    description: 'Wrapped up',
    icon: CheckCircle
  },
  {
    value: 'archived',
    label: 'Archived',
    description: 'Hidden from sidebar',
    icon: Archive
  }
]

interface StatusTabProps {
  currentStatus: WorkspaceStatus
  onStatusChange: (status: WorkspaceStatus) => void
}

function StatusTab({ currentStatus, onStatusChange }: StatusTabProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">
          Status
        </span>
        <StatusChip status={currentStatus} />
      </div>

      <div className="flex flex-col gap-1">
        {STATUS_STAGES.map((stage) => {
          const Icon = stage.icon
          const isActive = currentStatus === stage.value
          return (
            <button
              key={stage.value}
              onClick={() => {
                if (!isActive) onStatusChange(stage.value)
              }}
              disabled={isActive}
              className={[
                'flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
                isActive
                  ? 'bg-accent/10 cursor-default'
                  : 'hover:bg-surface-overlay cursor-pointer'
              ].join(' ')}
            >
              <Icon
                size={18}
                weight={isActive ? 'fill' : 'regular'}
                className={isActive ? 'text-accent flex-shrink-0' : 'text-text-muted flex-shrink-0'}
              />
              <div className="flex flex-col min-w-0">
                <span
                  className={[
                    'text-xs leading-tight',
                    isActive ? 'font-semibold text-accent' : 'font-medium text-text-primary'
                  ].join(' ')}
                >
                  {stage.label}
                </span>
                <span className="text-[10px] text-text-muted leading-tight mt-0.5">
                  {stage.description}
                </span>
              </div>
              {isActive && (
                <span className="ml-auto text-[10px] font-medium text-accent flex-shrink-0">
                  Current
                </span>
              )}
            </button>
          )
        })}
      </div>

      <p className="text-[10px] text-text-muted leading-relaxed mt-1">
        Switching to Archived hides this workspace from the sidebar. You can restore it from the
        project's archived list.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Overrides tab (migrated from WorkspaceOverridesPopover)
// ---------------------------------------------------------------------------

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
// Status chip — shared between drawer header and WorkspaceView header
// ---------------------------------------------------------------------------

export function StatusChip({ status }: { status: WorkspaceStatus }): React.JSX.Element {
  const stage = STATUS_STAGES.find((s) => s.value === status)!
  const Icon = stage.icon
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-overlay text-text-muted">
      <Icon size={10} weight="fill" />
      {stage.label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

export interface WorkspaceDrawerProps {
  workspace: WorkspaceRecord
  activeTab: 'status' | 'overrides'
  onTabChange: (tab: 'status' | 'overrides') => void
  onClose: () => void
  onStatusChange: (status: WorkspaceStatus) => void
}

export function WorkspaceDrawer({
  workspace,
  activeTab,
  onTabChange,
  onClose,
  onStatusChange
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
          <StatusTab currentStatus={workspace.status} onStatusChange={onStatusChange} />
        ) : (
          <OverridesTab workspaceId={workspace.id} />
        )}
      </div>
    </div>
  )
}
