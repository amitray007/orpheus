// ---------------------------------------------------------------------------
// src/main/ipc/shell.ts
//
// Shell helpers IPC — moved verbatim out of index.ts (STR-1). Reveal in
// Finder / open in editor / open terminal / clipboard / app listing. The
// editor/terminal handlers read the user's preferred app off AppUiState —
// passed in via deps.getAppUiState to avoid importing index.ts.
// ---------------------------------------------------------------------------

import {
  revealInFinder,
  openInEditor,
  openTerminal,
  copyToClipboard,
  listEditorApps,
  listTerminalApps
} from '../shellHelpers'
import type { AppUiState } from '../../shared/types'
import { handle } from './handle'
import { assertAbsolutePath } from './validate'

export interface ShellIpcDeps {
  getAppUiState: () => AppUiState
}

export function registerShellIpc(deps: ShellIpcDeps): void {
  handle('shell:revealInFinder', (_e, { path: filePath }: { path: string }) => {
    assertAbsolutePath(filePath, 'path')
    return revealInFinder(filePath)
  })
  handle('shell:openInEditor', (_e, { path: filePath }: { path: string }) => {
    assertAbsolutePath(filePath, 'path')
    const state = deps.getAppUiState()
    return openInEditor(filePath, state.preferredEditorApp ?? undefined)
  })
  handle('shell:openTerminal', (_e, { path: filePath }: { path: string }) => {
    assertAbsolutePath(filePath, 'path')
    const state = deps.getAppUiState()
    return openTerminal(filePath, state.preferredTerminalApp ?? undefined)
  })
  handle('shell:copyToClipboard', (_e, { text }: { text: string }) => copyToClipboard(text))
  handle('shell:listEditorApps', () => listEditorApps())
  handle('shell:listTerminalApps', () => listTerminalApps())
}
