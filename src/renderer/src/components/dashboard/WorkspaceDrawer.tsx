import { useEffect, useState } from 'react'
import type React from 'react'
import { X } from '@phosphor-icons/react'
import { SettingRow, SegmentedControl } from './settings/primitives'
import { ActivityIndicator } from './ActivityIndicator'
import {
  CLAUDE_MODEL_OPTIONS,
  type WorkspaceRecord,
  type WorkspaceStatus,
  type WorkspaceActivityDetail,
  type ClaudeWorkspaceSettings,
  type ClaudeWorkspaceSettingsOverrides,
  type ClaudePermissionMode,
  type ClaudeEffort
} from '@shared/types'

// ---------------------------------------------------------------------------
// Activity section — read-only auto-derived status display
// ---------------------------------------------------------------------------

const DETAIL_LABELS: Record<WorkspaceActivityDetail, string | null> = {
  thinking: 'thinking',
  tool: 'using a tool',
  asking: 'asking you a question',
  compacting: 'compacting context',
  ready: 'ready for your next message',
  attention: 'waiting on you',
  idle: 'not running',
  archived: null
}

const DETAIL_COLORS: Partial<Record<WorkspaceActivityDetail, string>> = {
  thinking: 'text-accent',
  tool: 'text-accent',
  asking: 'text-amber-400',
  compacting: 'text-accent',
  ready: 'text-emerald-400',
  attention: 'text-amber-400',
  idle: 'text-text-muted'
}

function statusToDetail(s: WorkspaceStatus): WorkspaceActivityDetail {
  return s === 'in_progress' ? 'thinking'
    : s === 'awaiting_input' ? 'ready'
    : s === 'attention' ? 'attention'
    : s === 'archived' ? 'archived'
    : 'idle'
}

interface ActivitySectionProps {
  activity: WorkspaceStatus
  detail: WorkspaceActivityDetail | undefined
  workspaceId: string
}

function ActivitySection({
  activity,
  detail,
  workspaceId
}: ActivitySectionProps): React.JSX.Element {
  const resolved = detail ?? statusToDetail(activity)
  const label = DETAIL_LABELS[resolved]
  const color = DETAIL_COLORS[resolved] ?? 'text-text-muted'
  const canReset = activity === 'in_progress' || activity === 'attention'

  function handleReset(): void {
    window.api.workspaces.resetActivity(workspaceId).catch((err) => {
      console.error('[drawer] resetActivity failed', err)
    })
  }

  return (
    <section className="flex flex-col gap-2 p-4 border-b border-border-default/40">
      <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">
        Activity
      </span>
      {label !== null ? (
        <p className="text-xs text-text-muted flex items-center gap-1.5">
          <ActivityIndicator detail={resolved} />
          Claude is <span className={color}>{label}</span>
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
    </section>
  )
}

// ---------------------------------------------------------------------------
// Overrides section
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

interface OverridesSectionProps {
  workspaceId: string
  isDirty: boolean
  onRestart: () => void
}

function OverridesSection({
  workspaceId,
  isDirty,
  onRestart
}: OverridesSectionProps): React.JSX.Element {
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
    <section className="flex flex-col">
      <div className="px-4 pt-4 pb-1">
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

      {isDirty && (
        <div className="mx-4 mt-2 px-3 py-2 rounded-md border border-amber-400/30 bg-amber-400/5 flex items-center gap-2">
          <span className="text-[11px] font-mono text-amber-400 flex-shrink-0">
            Settings changed
          </span>
          <button
            onClick={onRestart}
            className="ml-auto text-[11px] font-sans font-medium text-amber-300 hover:text-amber-100 underline underline-offset-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/40"
          >
            Restart to apply
          </button>
        </div>
      )}

      {hasAnyOverride && (
        <div className="px-4 py-3 mt-1">
          <button
            onClick={resetAll}
            className="text-xs text-text-muted hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
          >
            Reset all overrides
          </button>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

export interface WorkspaceDrawerProps {
  workspace: WorkspaceRecord
  activity: WorkspaceStatus
  detail: WorkspaceActivityDetail | undefined
  onClose: () => void
  onRestart: () => void
}

export function WorkspaceDrawer({
  workspace,
  activity,
  detail,
  onClose,
  onRestart
}: WorkspaceDrawerProps): React.JSX.Element {
  const [isDirty, setIsDirty] = useState(false)

  useEffect(() => {
    const workspaceId = workspace.id
    window.api.workspaces
      .isDirty(workspaceId)
      .then(setIsDirty)
      .catch(() => setIsDirty(false))
    return window.api.workspaces.onDirtyChanged((e) => {
      if (e.workspaceId === workspaceId) setIsDirty(e.dirty)
    })
  }, [workspace.id])

  return (
    <div className="flex flex-col h-full w-full">
      {/* Drawer header — just the close button */}
      <div className="h-8 flex items-center px-2 border-b border-border-default flex-shrink-0">
        <span className="text-[11px] font-medium text-text-muted px-1.5">
          Workspace Settings
        </span>
        <button
          onClick={onClose}
          className="ml-auto w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          aria-label="Close drawer"
        >
          <X size={11} weight="bold" />
        </button>
      </div>

      {/* Drawer body — single scrollable column */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <ActivitySection
          activity={activity}
          detail={detail}
          workspaceId={workspace.id}
        />
        <OverridesSection
          workspaceId={workspace.id}
          isDirty={isDirty}
          onRestart={onRestart}
        />
      </div>
    </div>
  )
}
