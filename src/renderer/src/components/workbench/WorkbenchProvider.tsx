// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/WorkbenchProvider.tsx
//
// U4 (P1) — the single component export that wraps `WorkbenchContext`
// (workbenchReducer.ts) so WorkbenchPanel (the frame) and WorkspaceTitleBar
// (the "Workbench" button + section-2 restore control) share one state-
// machine instance. Mounted in WorkspaceView, only when workbenchEnabled.
// ---------------------------------------------------------------------------

import type React from 'react'
import { WorkbenchContext, type WorkbenchApi } from './workbenchReducer'

export function WorkbenchProvider({
  children,
  value
}: {
  children: React.ReactNode
  value: WorkbenchApi
}): React.JSX.Element {
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
}
