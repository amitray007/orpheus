import type {
  PaneStateV1,
  RendererControlCommand,
  WorkbenchStateV1
} from '@shared/workbenchControl'
import { getFilesTabEntry, setFilesTabEntry } from './filesTabStore'
import { getPaneRunning, setPaneRunning } from './paneRunStateStore'
import { getPanesSelection, setActiveLayout, setActivePanel } from './panesSelectionStore'
import {
  getControlledPaneFocus,
  getWorkbenchDiffPath,
  getWorkbenchDiffTarget,
  setControlledPaneFocus,
  setWorkbenchDiffTarget
} from './workbenchControlStore'
import { getWorkbenchEntry, selectWorkbenchTab } from './workbenchStore'

function workbenchState(workspaceId: string): WorkbenchStateV1 {
  const workbench = getWorkbenchEntry(workspaceId)
  const file = getFilesTabEntry(workspaceId)
  const diff = getWorkbenchDiffTarget(workspaceId)
  const diffPath = getWorkbenchDiffPath(workspaceId)
  return {
    schemaVersion: 1,
    workspaceId,
    observedAt: Date.now(),
    source: 'renderer-live',
    workbench: { state: workbench.state, activeTab: workbench.activeTab },
    file:
      file.selectedFile == null
        ? null
        : { path: file.selectedFile, mode: file.mode === 'editor' ? 'viewer' : file.mode },
    diff:
      diff == null
        ? null
        : diff.kind === 'working-tree-file'
          ? { kind: diff.kind, path: diff.path, reviewId: null }
          : { kind: diff.kind, path: diffPath ?? '', reviewId: diff.reviewId }
  }
}

async function paneState(layoutId: string): Promise<PaneStateV1> {
  const panels = await window.api.panes.listPanels()
  for (const panel of panels) {
    const layout = (await window.api.panes.listLayouts(panel.id)).find(
      (item) => item.id === layoutId
    )
    if (layout == null) continue
    const terminals = await window.api.panes.listTerminals(layoutId)
    const selection = getPanesSelection()
    const focused = getControlledPaneFocus(layoutId)
    return {
      schemaVersion: 1,
      observedAt: Date.now(),
      source: 'renderer-live',
      layoutId,
      panelId: panel.id,
      selected: selection.activeLayoutId === layoutId,
      focusedTerminalId: focused,
      terminals: terminals.map((terminal) => ({
        terminalId: terminal.id,
        selected: focused === terminal.id,
        desiredState: getPaneRunning(terminal.id) ? 'running' : 'stopped'
      }))
    }
  }
  throw new Error('Pane resource was not found.')
}

async function selectPaneLayout(layoutId: string): Promise<PaneStateV1> {
  const state = await paneState(layoutId)
  setActivePanel(state.panelId)
  setActiveLayout(layoutId)
  await window.api.uiState.update({
    lastPanelId: state.panelId,
    lastLayoutId: layoutId
  })
  return paneState(layoutId)
}

export async function executeRendererControl(command: RendererControlCommand): Promise<unknown> {
  switch (command.kind) {
    case 'workbench.readState':
      return workbenchState(command.workspaceId)
    case 'workbench.selectTab':
      selectWorkbenchTab(command.workspaceId, command.tab)
      return workbenchState(command.workspaceId)
    case 'workbench.openFile': {
      await window.api.files.readFile(command.workspaceId, command.path)
      selectWorkbenchTab(command.workspaceId, 'files')
      const previous = getFilesTabEntry(command.workspaceId)
      setFilesTabEntry(command.workspaceId, {
        ...previous,
        selectedFile: command.path,
        mode: command.mode,
        expandedPaths: command.path
          .split('/')
          .slice(0, -1)
          .map((_, index, parts) => `${parts.slice(0, index + 1).join('/')}/`)
      })
      return workbenchState(command.workspaceId)
    }
    case 'workbench.openDiff': {
      let path: string
      const target = command.target
      if (target.kind === 'working-tree-file') {
        const result = await window.api.git.diff(command.workspaceId, true)
        if (!('files' in result) || !result.files.some((file) => file.path === target.path)) {
          throw new Error('Working-tree diff target was not found.')
        }
        path = target.path
      } else {
        const review = (await window.api.reviews.list(command.workspaceId)).find(
          (item) => item.id === target.reviewId
        )
        if (review == null) throw new Error('Local review target was not found.')
        path = review.path
      }
      selectWorkbenchTab(command.workspaceId, 'git')
      setWorkbenchDiffTarget(command.workspaceId, target, path)
      return workbenchState(command.workspaceId)
    }
    case 'panes.readState':
      return paneState(command.layoutId)
    case 'panes.selectLayout': {
      return selectPaneLayout(command.layoutId)
    }
    case 'panes.validateTerminal':
      return paneState(command.layoutId)
    case 'panes.presentTerminal': {
      await selectPaneLayout(command.layoutId)
      setControlledPaneFocus(command.layoutId, command.terminalId)
      return paneState(command.layoutId)
    }
    case 'panes.commitTerminalState':
      setPaneRunning(command.terminalId, command.desiredState === 'running')
      if (
        command.desiredState === 'stopped' &&
        getControlledPaneFocus(command.layoutId) === command.terminalId
      ) {
        setControlledPaneFocus(command.layoutId, null)
      }
      return paneState(command.layoutId)
  }
}
