import type { PaneLayout, PaneTerminal } from '../../shared/types'
import type { WorkbenchControlPorts } from './service'

export type MainPaneControlDeps = {
  getLayout: (layoutId: string) => PaneLayout | null
  listTerminals: (layoutId: string) => PaneTerminal[]
  startConfigured: (
    layout: PaneLayout,
    terminal: PaneTerminal
  ) => 'started' | 'retained' | Promise<'started' | 'retained'>
  stopSurface: (
    layoutId: string,
    terminalId: string
  ) => 'stopped' | 'absent' | Promise<'stopped' | 'absent'>
  focusSurface: (layoutId: string, terminalId: string) => void | Promise<void>
}

export function createMainPaneControlPort(
  deps: MainPaneControlDeps
): WorkbenchControlPorts['panes'] {
  return {
    resolve(layoutId, terminalId) {
      const layout = deps.getLayout(layoutId)
      if (layout == null) return null
      if (
        terminalId != null &&
        !deps.listTerminals(layoutId).some((terminal) => terminal.id === terminalId)
      ) {
        return null
      }
      return { layoutId, terminalId, panelId: layout.panelId }
    },
    start(layoutId, terminalId) {
      const layout = deps.getLayout(layoutId)
      const terminal = deps.listTerminals(layoutId).find((candidate) => candidate.id === terminalId)
      if (layout == null || terminal == null) {
        return Promise.reject(new Error('Pane terminal is unavailable.'))
      }
      return Promise.resolve(deps.startConfigured(layout, terminal))
    },
    stop(layoutId, terminalId) {
      const layout = deps.getLayout(layoutId)
      const terminal = deps.listTerminals(layoutId).find((candidate) => candidate.id === terminalId)
      if (layout == null || terminal == null) {
        return Promise.reject(new Error('Pane terminal is unavailable.'))
      }
      return Promise.resolve(deps.stopSurface(layoutId, terminalId))
    },
    focus(layoutId, terminalId) {
      const layout = deps.getLayout(layoutId)
      const terminal = deps.listTerminals(layoutId).find((candidate) => candidate.id === terminalId)
      if (layout == null || terminal == null) {
        return Promise.reject(new Error('Pane terminal is unavailable.'))
      }
      return Promise.resolve(deps.focusSurface(layoutId, terminalId))
    }
  }
}
