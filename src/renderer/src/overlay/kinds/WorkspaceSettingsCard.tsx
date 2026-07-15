import type React from 'react'
import type { WorkspaceSettingsCardProps } from '@shared/types'
import {
  Eyebrow,
  Toggle,
  CliFlagsEditor,
  CustomEnvVarsEditor
} from '../../components/dashboard/settings/primitives'
import type { OverlayKindProps } from '../registry'

// ---------------------------------------------------------------------------
// WorkspaceSettingsCard — the workspace title bar Settings gear popover,
// ported to the child-window overlay layer (see docs/learnings/overlay-
// child-window-macos.md and this kind's entry in registry.tsx). A same-window
// DOM node can never paint above the terminal's NSView, and the gear opens
// downward off a title-bar anchor straight into the terminal rect — so this
// kind can't be an in-page `Overlay` (the retired WorkspaceSettingsPopover
// approach) the way TreeOptionsPopover is (that popover lives inside the
// workbench pane, a flex sibling of the claude column, so its rect never
// overlaps the terminal — a geometrically different case, not a precedent
// here).
//
// Props down, events up: this component owns NO window.api calls and NO data
// hooks — every field is a serializable snapshot pushed by the main-window
// call site (WorkspaceSettingsPopover.tsx), and every interaction is an
// `emit(type, payload)` the call site turns back into a
// `claudeWorkspaceSettings.update(...)` call + a follow-up
// `updateWorkspaceSettingsCard` push. `locoEnabled` is never local state here
// — it's derived upstream from `flags` and handed down read-only, same as the
// original popover's derived-toggle rule.
//
// Emitted event types: 'toggleLoco' { value }, 'changeFlags' { flags },
// 'changeEnvVars' { envVars }, 'restart'.
// ---------------------------------------------------------------------------

export function WorkspaceSettingsCard({ props, emit }: OverlayKindProps): React.JSX.Element {
  const data = props as unknown as WorkspaceSettingsCardProps
  const { locoEnabled, flags, inheritedFlags, envVars, loading, isDirty } = data

  return (
    <div className="w-80 rounded-md border border-border-default bg-surface-overlay shadow-lg p-3 font-[family-name:var(--font-sans)]">
      <div
        role="dialog"
        aria-label="Workspace Settings"
        className={loading ? 'opacity-50 pointer-events-none' : undefined}
      >
        <Eyebrow className="mb-2">Plugins</Eyebrow>
        <div className="flex items-center justify-between gap-6 py-1">
          <span className="text-xs text-text-primary select-none">Enable Loco Channel</span>
          <Toggle
            value={locoEnabled}
            onChange={(value) => emit('toggleLoco', { value })}
            ariaLabel="Enable Loco Channel"
          />
        </div>

        <div className="my-3 border-t border-border-default/60" />

        <Eyebrow className="mb-2">Custom CLI flags</Eyebrow>
        <CliFlagsEditor
          value={flags}
          onChange={(next) => emit('changeFlags', { flags: next })}
          inheritedFlags={inheritedFlags}
          placeholder="--dangerously-load-development-channels server:loco"
        />

        <div className="my-3 border-t border-border-default/60" />

        <Eyebrow className="mb-2">Custom env vars</Eyebrow>
        <CustomEnvVarsEditor
          value={envVars}
          onChange={(next) => emit('changeEnvVars', { envVars: next })}
        />

        {isDirty && (
          <>
            <div className="my-3 border-t border-border-default/60" />
            <div className="rounded-md border border-amber-400/30 bg-amber-400/[0.04] px-3 py-2.5 flex items-center gap-3">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
              <span className="text-sm text-amber-200/90 flex-shrink-0">Settings changed</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  emit('restart')
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className="ml-auto text-sm font-medium text-amber-300 hover:text-amber-100 underline underline-offset-2 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/40 rounded"
              >
                Restart to apply
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
