// ---------------------------------------------------------------------------
// src/renderer/src/components/dashboard/WorkspaceSettingsPopover.tsx
//
// Workspace-scope Settings popover, opened from the Settings gear beside the
// Workbench opener in WorkspaceTitleBar (see docs/superpowers/specs/
// 2026-07-15-workspace-settings-popover-design.md). Sections: the Plugins
// toggle (Loco channel), the Custom CLI flags editor, and the Custom env vars
// editor — all at workspace scope.
//
// Ported to the child-window overlay layer (see docs/learnings/overlay-
// child-window-macos.md). The gear lives in the workspace title bar and opens
// DOWNWARD (rect.bottom + 4) straight into the live terminal's rect; a
// same-window DOM node — which is all an in-page `Overlay` (this file's
// original approach, copied from TreeOptionsPopover.tsx) can ever be — can
// never paint above the terminal's NSView, so that approach silently rendered
// behind the terminal. TreeOptionsPopover is NOT a valid precedent here: it
// lives inside the workbench pane, a flex sibling of the claude column, so
// its rect geometrically never overlaps the terminal — this popover's rect
// does. commit 793cbb23 audited this exact confusion; don't repeat it.
//
// Props down, events up (the decided architecture — see the overlay-child-
// window doc + WorkspaceSettingsCard.tsx's header): this component keeps ALL
// data hooks and every `window.api.claudeWorkspaceSettings.*` call. The
// overlay kind (WorkspaceSettingsCard) is dumb — it only renders the
// serializable props pushed via showWorkspaceSettingsCard/
// updateWorkspaceSettingsCard and emits events, which this component routes
// back into the hooks below via onWorkspaceSettingsCardEvent, then pushes the
// resulting state back with updateWorkspaceSettingsCard (mirrors
// WorkspaceTitleBar's showDetailsCard/updateDetailsCard loop).
//
// The Loco toggle is a DERIVED view over customCliFlags, not independent
// state: it renders `flags.some(flagName(e) === LOCO_FLAG_NAME)` every
// render, so hand-editing/deleting the flag row in the editor below updates
// the toggle on the same render — there is never a second source of truth to
// fall out of sync (see the design doc's "toggle is a derived view" section).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { Gear } from '@phosphor-icons/react'
import { flagName } from '@shared/cliFlags'
import type {
  ClaudeWorkspaceSettings,
  ClaudeWorkspaceSettingsOverrides,
  WorkspaceSettingsCardProps
} from '@shared/types'
import {
  showWorkspaceSettingsCard,
  updateWorkspaceSettingsCard,
  hideWorkspaceSettingsCard,
  workspaceSettingsCardId,
  onWorkspaceSettingsCardEvent
} from '@/lib/overlayClient'

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

// Same stable-fallback rationale as EMPTY_FLAGS, for CustomEnvVarsEditor's
// `value` prop — a fresh `{}` literal allocated inline every render would
// give the editor's resync effect (`useEffect(() => setRows(...), [value])`)
// a new dependency identity every render, refiring the resync and destroying
// in-progress typing/focus. Module-level singleton so the reference is stable.
const EMPTY_ENV_VARS: Record<string, string> = {}

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

/** Loads + patches this workspace's customEnvVars override — same shape as
 *  useWorkspaceCliFlags above, minus the derived-toggle bit (env vars have no
 *  Plugins-toggle sugar). Isolated into its own hook for the same reason. */
function useWorkspaceEnvVars(workspaceId: string): {
  envVarsValue: Record<string, string>
  loading: boolean
  setEnvVars: (v: Record<string, string>) => void
} {
  const [settings, setSettings] = useState<ClaudeWorkspaceSettings | null>(null)
  const [localEnvVars, setLocalEnvVars] = useState<Record<string, string>>(EMPTY_ENV_VARS)

  useEffect(() => {
    let cancelled = false
    window.api.claudeWorkspaceSettings
      .get(workspaceId)
      .then((s) => {
        if (cancelled) return
        setSettings(s)
        setLocalEnvVars(s.overrides.customEnvVars ?? EMPTY_ENV_VARS)
      })
      .catch((err) => console.error('[WorkspaceSettingsPopover] env vars load failed', err))
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const patch = useCallback(
    (update: ClaudeWorkspaceSettingsOverrides): void => {
      window.api.claudeWorkspaceSettings.update(workspaceId, update).catch((err) => {
        console.error('[WorkspaceSettingsPopover] env vars update failed; refetching', err)
        window.api.claudeWorkspaceSettings
          .get(workspaceId)
          .then((s) => {
            setSettings(s)
            setLocalEnvVars(s.overrides.customEnvVars ?? EMPTY_ENV_VARS)
          })
          .catch(console.error)
      })
    },
    [workspaceId]
  )

  const setEnvVars = useCallback(
    (v: Record<string, string>) => {
      setLocalEnvVars(v)
      patch({ customEnvVars: Object.keys(v).length > 0 ? v : undefined })
    },
    [patch]
  )

  return {
    envVarsValue: localEnvVars,
    loading: settings === null,
    setEnvVars
  }
}

export function WorkspaceSettingsPopover({
  workspaceId,
  projectId,
  onRestart,
  isDirty
}: WorkspaceSettingsPopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const cardId = workspaceSettingsCardId(workspaceId)

  const { flagsValue, loading, setFlags, locoEnabled, setLocoEnabled } =
    useWorkspaceCliFlags(workspaceId)
  const inheritedFlags = useInheritedCliFlags(projectId)
  const { envVarsValue, loading: envVarsLoading, setEnvVars } = useWorkspaceEnvVars(workspaceId)

  // Stable identity for CliFlagsEditor's `value` prop — see EMPTY_FLAGS above.
  const cliFlagsValue = useMemo(
    () => (flagsValue.length > 0 ? flagsValue : EMPTY_FLAGS),
    [flagsValue]
  )

  // Stable identity for CustomEnvVarsEditor's `value` prop — see
  // EMPTY_ENV_VARS above.
  const envVarsFieldValue = useMemo(
    () => (Object.keys(envVarsValue).length > 0 ? envVarsValue : EMPTY_ENV_VARS),
    [envVarsValue]
  )

  function close(): void {
    setOpen(false)
    hideWorkspaceSettingsCard(cardId)
  }

  function handleTriggerClick(e: React.MouseEvent): void {
    e.stopPropagation()
    if (open) {
      close()
      return
    }
    if (!buttonRef.current) return
    const initialProps: WorkspaceSettingsCardProps = {
      locoEnabled,
      flags: cliFlagsValue,
      inheritedFlags,
      envVars: envVarsFieldValue,
      loading: loading || envVarsLoading,
      isDirty
    }
    showWorkspaceSettingsCard(workspaceId, buttonRef.current, initialProps)
    setOpen(true)
  }

  // Route the card's emitted events back into the data hooks above, then
  // push the resulting state back down via updateWorkspaceSettingsCard — the
  // same "emit -> hook call -> update() push" loop WorkspaceTitleBar's
  // details popover uses for its Restart chip.
  useEffect(() => {
    if (!open) return undefined
    return onWorkspaceSettingsCardEvent(cardId, {
      onToggleLoco: setLocoEnabled,
      onChangeFlags: setFlags,
      onChangeEnvVars: setEnvVars,
      onRestart: () => onRestart?.(),
      onCancel: close
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cardId, setLocoEnabled, setFlags, setEnvVars, onRestart])

  // Keep the open card's props in sync as the underlying settings/dirty
  // state changes (async load resolving, an edit landing, isDirty flipping)
  // — mirrors WorkspaceTitleBar's isDirty->updateDetailsCard effect.
  useEffect(() => {
    if (!open) return
    updateWorkspaceSettingsCard(cardId, {
      locoEnabled,
      flags: cliFlagsValue,
      inheritedFlags,
      envVars: envVarsFieldValue,
      loading: loading || envVarsLoading,
      isDirty
    })
  }, [
    open,
    cardId,
    locoEnabled,
    cliFlagsValue,
    inheritedFlags,
    envVarsFieldValue,
    loading,
    envVarsLoading,
    isDirty
  ])

  // Outside-click dismissal: the card lives in a separate child BrowserWindow,
  // so the main renderer's document-level listener never sees clicks landing
  // INSIDE the card — only clicks in the main window (including the
  // terminal) reach here, which is exactly the "outside" set for this
  // popover (same pattern as ActionChip's chipPrompt outside-click effect).
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (e: PointerEvent): void => {
      if (buttonRef.current && buttonRef.current.contains(e.target as Node)) return
      close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Hide on unmount/workspace change so a stale card never outlives its
  // owning title bar.
  useEffect(() => {
    return () => hideWorkspaceSettingsCard(cardId)
  }, [cardId])

  return (
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
  )
}
