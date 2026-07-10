// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/workbenchTabs.ts
//
// U5 (P1) — shared tab id/definition types + the ordered tab list, split out
// of WorkbenchTabStrip.tsx so that file exports only the component
// (react-refresh/only-export-components forbids mixing non-component
// exports like a const array/type into a component file — see
// workbenchReducer.ts for the same split applied to the state machine).
// ---------------------------------------------------------------------------

import type React from 'react'
import { GitBranch, Terminal, Folder } from '@phosphor-icons/react'

export type WorkbenchTabId = 'git' | 'terminal' | 'files'

export interface WorkbenchTabDef {
  id: WorkbenchTabId
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
}

// Order matches the requirements doc: Git · Terminal · Files.
export const WORKBENCH_TABS: readonly WorkbenchTabDef[] = [
  { id: 'git', label: 'Git', icon: GitBranch },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'files', label: 'Files', icon: Folder }
]
