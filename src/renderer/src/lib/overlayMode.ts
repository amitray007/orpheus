import { createContext, useContext, useEffect } from 'react'

// Dynamic z-order coordination for the libghostty NSView.
//
// Default (fast path): the terminal NSView sits on TOP of Electron's
// WebContents — opaque, no compositor blend, identical perf to a non-Electron
// terminal. This is the architecture's resting state.
//
// Overlay path: when a DOM popover / modal / drawer needs to paint ABOVE the
// terminal, it calls useTerminalOverlay() inside its body. The hook
// increments a ref-counted context; on the 0→1 transition the provider
// dispatches terminal:setOverlay(true) over IPC, which the addon translates
// to addSubview:positioned:NSWindowBelow — sliding the terminal behind the
// WebContents for the lifetime of the overlay. The 1→0 transition restores
// the fast path. Nested overlays nest cleanly because of the refcount.
//
// The provider (in OverlayModeProvider.tsx) holds the refcount and tracks
// the "active" workspaceId so setOverlay targets the right surface;
// WorkspaceView calls useSetActiveOverlayWorkspace at mount time and clears
// it on unmount.

export interface OverlayModeApi {
  setActiveWorkspace: (workspaceId: string | null) => void
  acquire: () => void
  release: () => void
}

export const OverlayModeContext = createContext<OverlayModeApi | null>(null)

// Hook for any component that paints visually above the terminal. While the
// caller is mounted, the terminal NSView is z-ordered behind the WebContents
// so the DOM can render on top of it. On unmount the terminal snaps back to
// the fast path. Refcounted across simultaneous overlays.
export function useTerminalOverlay(): void {
  const ctx = useContext(OverlayModeContext)
  useEffect(() => {
    if (!ctx) return
    ctx.acquire()
    return () => ctx.release()
  }, [ctx])
}

// Internal: WorkspaceView calls this with its workspaceId on mount, and null
// on unmount, so the provider knows which surface setOverlay should target.
export function useSetActiveOverlayWorkspace(workspaceId: string | null): void {
  const ctx = useContext(OverlayModeContext)
  useEffect(() => {
    if (!ctx) return
    ctx.setActiveWorkspace(workspaceId)
    return () => ctx.setActiveWorkspace(null)
  }, [ctx, workspaceId])
}
