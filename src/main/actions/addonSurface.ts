// ---------------------------------------------------------------------------
// actions/addonSurface.ts — Shared addon reference for terminal surface ops.
//
// Extracted from actions/index.ts to break the mutual-import cycle between
// index.ts (imports workspace handlers) and workspace.ts (needed destroyAddonSurface).
// Both files now import from here; neither imports from the other.
// ---------------------------------------------------------------------------

type AddonRef = {
  sendInput: (workspaceId: string, utf8Text: string) => boolean
  sendKeys: (
    workspaceId: string,
    keys: Array<{ keycode: number; mods?: number; action?: 'press' | 'release' | 'repeat' }>
  ) => boolean
  destroy: (workspaceId: string) => void
}

let addonRef: AddonRef | null = null

/** Called from index.ts once the addon is loaded, to wire terminal actions. */
export function setTerminalAddonRef(addon: AddonRef | null): void {
  addonRef = addon
}

/** Returns the current addon reference, or null if not yet loaded. */
export function getAddonRef(): AddonRef | null {
  return addonRef
}

/**
 * Destroy the libghostty surface for a workspace.
 * Silently no-ops when the addon isn't loaded or the surface wasn't mounted.
 * Used by handleArchive so workspace.ts doesn't need a direct addon import.
 */
export function destroyAddonSurface(workspaceId: string): void {
  if (!addonRef) return
  try {
    addonRef.destroy(workspaceId)
  } catch {
    // Surface was never mounted or already destroyed — ignore.
  }
}
