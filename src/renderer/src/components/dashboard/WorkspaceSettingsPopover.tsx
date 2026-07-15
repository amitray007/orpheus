// ---------------------------------------------------------------------------
// src/renderer/src/components/dashboard/WorkspaceSettingsPopover.tsx
//
// Workspace-scope Settings popover, opened from the Settings gear beside the
// Workbench opener in WorkspaceTitleBar (see docs/superpowers/specs/
// 2026-07-15-workspace-settings-popover-design.md). Unit 3 of that design:
// FLAGS ONLY — the Plugins toggle (Loco channel) + the Custom CLI flags
// editor, at workspace scope. Custom env vars are a separate, later unit (see
// the design doc's "Scope note" — flags and env vars are deliberately
// separable).
//
// Follows the repo's established anchored-popover pattern (useAnchoredPopover
// + a portaled interactive Overlay) — copied from TreeOptionsPopover.tsx, the
// closest precedent — rather than radix-ui's Popover, which is a dependency
// but not what these surfaces use.
//
// The Loco toggle is a DERIVED view over customCliFlags, not independent
// state: it renders `flags.some(flagName(e) === LOCO_FLAG_NAME)` every
// render, so hand-editing/deleting the flag row in the editor below updates
// the toggle on the same render — there is never a second source of truth to
// fall out of sync (see the design doc's "toggle is a derived view" section).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { Gear } from '@phosphor-icons/react'
import { flagName } from '@shared/cliFlags'
import type { ClaudeWorkspaceSettings, ClaudeWorkspaceSettingsOverrides } from '@shared/types'
import { Overlay } from '../ui/Overlay'
import { Eyebrow, Toggle, CliFlagsEditor } from './settings/primitives'
import { useAnchoredPopover } from '../workbench/useAnchoredPopover'

/** The flag name + full entry the Plugins toggle is sugar over. Repeating
 *  this flag across scopes is safe (REPEATABLE in cliFlags.ts), so appending
 *  it at workspace scope never destroys a project-level channel. */
const LOCO_FLAG_NAME = '--dangerously-load-development-channels'
const LOCO_FLAG_ENTRY = `${LOCO_FLAG_NAME} server:loco`

// Stable fallback identity for CliFlagsEditor's `value`/`inheritedFlags`
// props — mirrors SettingsDrawer.tsx's EMPTY_FLAGS. A fresh `[]` literal
// allocated inline every render would defeat CliFlagsEditor's render-time
// prevValueRef sync guard and CliFlagsPreview's memo, reintroducing the
// flicker fixed in f621921f (reverted 4440db8a, reapplied 3676a313 — current
// HEAD).
const EMPTY_FLAGS: string[] = []

/** Loads global + project customCliFlags so the popover's CliFlagsEditor can
 *  render them muted in the command preview (CliFlagsEditor's
 *  `inheritedFlags` prop — see primitives.tsx's CliFlagsPreview). Workspace
 *  is the only tier with TWO upstream scopes, so both are fetched and
 *  concatenated global-then-project (lowest precedence first) as RAW ENTRY
 *  strings — CliFlagsPreview internally tokenizes each entry and re-derives
 *  per-entry survival via the real mergeFlagScopes, so a flat concatenation
 *  in scope order is exactly the shape it expects (not pre-merged tokens). */
function useInheritedCliFlags(projectId: string): string[] {
  const [globalFlags, setGlobalFlags] = useState<string[]>([])
  const [projectFlags, setProjectFlags] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    window.api.claudeSettings
      .get()
      .then((s) => {
        if (!cancelled) setGlobalFlags(s.customCliFlags ?? [])
      })
      .catch((err) => console.error('[WorkspaceSettingsPopover] global flags load failed', err))
    window.api.claudeProjectSettings
      .get(projectId)
      .then((s) => {
        if (!cancelled) setProjectFlags(s.overrides.customCliFlags ?? [])
      })
      .catch((err) => console.error('[WorkspaceSettingsPopover] project flags load failed', err))
    return () => {
      cancelled = true
    }
  }, [projectId])

  return useMemo(() => {
    if (globalFlags.length === 0 && projectFlags.length === 0) return EMPTY_FLAGS
    return [...globalFlags, ...projectFlags]
  }, [globalFlags, projectFlags])
}

export interface WorkspaceSettingsPopoverProps {
  workspaceId: string
  /** Owning project, needed to fetch project-scope flags for the inherited
   *  (muted) preview — see useInheritedCliFlags above. */
  projectId: string
  /** Restarts the workspace to apply pending settings changes — threaded
   *  down from WorkspaceView's component-local remountKey state (there is no
   *  terminal:restart IPC channel; see WorkspaceTitleBarProps.onRestart). */
  onRestart?: () => void
  /** Same dirty flag WorkspaceTitleBar already tracks for the title-hover
   *  details popover's chip — reused here rather than a third independent
   *  dirty-chip home. */
  isDirty: boolean
}

/** Loads + patches this workspace's customCliFlags override, exposing both
 *  the raw editor value and the derived Loco toggle state. Isolated into its
 *  own hook so the popover component stays focused on layout. */
function useWorkspaceCliFlags(workspaceId: string): {
  flagsValue: string[]
  loading: boolean
  setFlags: (v: string[]) => void
  locoEnabled: boolean
  setLocoEnabled: (v: boolean) => void
} {
  const [settings, setSettings] = useState<ClaudeWorkspaceSettings | null>(null)
  const [localFlags, setLocalFlags] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    window.api.claudeWorkspaceSettings
      .get(workspaceId)
      .then((s) => {
        if (cancelled) return
        setSettings(s)
        setLocalFlags(s.overrides.customCliFlags ?? [])
      })
      .catch((err) => console.error('[WorkspaceSettingsPopover] load failed', err))
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const patch = useCallback(
    (update: ClaudeWorkspaceSettingsOverrides): void => {
      window.api.claudeWorkspaceSettings.update(workspaceId, update).catch((err) => {
        console.error('[WorkspaceSettingsPopover] update failed; refetching', err)
        window.api.claudeWorkspaceSettings
          .get(workspaceId)
          .then((s) => {
            setSettings(s)
            setLocalFlags(s.overrides.customCliFlags ?? [])
          })
          .catch(console.error)
      })
    },
    [workspaceId]
  )

  const setFlags = useCallback(
    (v: string[]) => {
      setLocalFlags(v)
      patch({ customCliFlags: v.length > 0 ? v : undefined })
    },
    [patch]
  )

  const locoEnabled = localFlags.some((e) => flagName(e) === LOCO_FLAG_NAME)

  const setLocoEnabled = useCallback(
    (v: boolean) => {
      const withoutLoco = localFlags.filter((e) => flagName(e) !== LOCO_FLAG_NAME)
      setFlags(v ? [...withoutLoco, LOCO_FLAG_ENTRY] : withoutLoco)
    },
    [localFlags, setFlags]
  )

  return {
    flagsValue: localFlags,
    loading: settings === null,
    setFlags,
    locoEnabled,
    setLocoEnabled
  }
}

export function WorkspaceSettingsPopover({
  workspaceId,
  projectId,
  onRestart,
  isDirty
}: WorkspaceSettingsPopoverProps): React.JSX.Element {
  const { open, setOpen, anchorPos, buttonRef, handleTriggerClick } = useAnchoredPopover()
  const { flagsValue, loading, setFlags, locoEnabled, setLocoEnabled } =
    useWorkspaceCliFlags(workspaceId)
  const inheritedFlags = useInheritedCliFlags(projectId)

  // Stable identity for CliFlagsEditor's `value` prop — see EMPTY_FLAGS above.
  const cliFlagsValue = useMemo(
    () => (flagsValue.length > 0 ? flagsValue : EMPTY_FLAGS),
    [flagsValue]
  )

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={handleTriggerClick}
        title="Workspace Settings"
        aria-label="Workspace Settings"
        aria-expanded={open}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs flex-shrink-0 text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        <Gear size={14} />
        <span>Settings</span>
      </button>
      <Overlay
        open={open}
        interactive
        onDismiss={() => setOpen(false)}
        portal
        className="fixed z-50 w-80 rounded-md border border-border-default bg-surface-overlay shadow-lg p-3"
        style={anchorPos ?? undefined}
      >
        <div
          role="dialog"
          aria-label="Workspace Settings"
          className={loading ? 'opacity-50 pointer-events-none' : undefined}
        >
          <Eyebrow className="mb-2">Plugins</Eyebrow>
          <div className="flex items-center justify-between gap-6 py-1">
            <span className="text-xs text-text-primary select-none">Enable Loco Channel</span>
            <Toggle value={locoEnabled} onChange={setLocoEnabled} ariaLabel="Enable Loco Channel" />
          </div>

          <div className="my-3 border-t border-border-default/60" />

          <Eyebrow className="mb-2">Custom CLI flags</Eyebrow>
          <CliFlagsEditor
            value={cliFlagsValue}
            onChange={setFlags}
            inheritedFlags={inheritedFlags}
            placeholder="--dangerously-load-development-channels server:loco"
          />

          {isDirty && (
            <>
              <div className="my-3 border-t border-border-default/60" />
              <div className="rounded-md border border-amber-400/30 bg-amber-400/[0.04] px-3 py-2.5 flex items-center gap-3">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
                <span className="text-sm text-amber-200/90 flex-shrink-0">Settings changed</span>
                <button
                  type="button"
                  onClick={() => onRestart?.()}
                  className="ml-auto text-sm font-medium text-amber-300 hover:text-amber-100 underline underline-offset-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/40 rounded"
                >
                  Restart to apply
                </button>
              </div>
            </>
          )}
        </div>
      </Overlay>
    </>
  )
}
