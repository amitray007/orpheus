import type { WorkbenchDiffTarget } from '@shared/workbenchControl'
import { createPerKeyStore } from './createPerKeyStore'

type WorkbenchDiffSelection = {
  target: WorkbenchDiffTarget
  resolvedPath: string | null
}

const diffStore = createPerKeyStore<WorkbenchDiffSelection>({
  equals: (previous, next) =>
    previous.resolvedPath === next.resolvedPath &&
    JSON.stringify(previous.target) === JSON.stringify(next.target)
})
const paneFocusStore = createPerKeyStore<string | null>()

export function setWorkbenchDiffTarget(
  workspaceId: string,
  target: WorkbenchDiffTarget | null,
  resolvedPath: string | null = null
): void {
  if (target == null) {
    diffStore.remove(workspaceId)
    return
  }
  diffStore.set(workspaceId, { target, resolvedPath })
}

export function getWorkbenchDiffPath(workspaceId: string): string | null {
  return diffStore.raw.get(workspaceId)?.resolvedPath ?? null
}

export function getWorkbenchDiffTarget(workspaceId: string): WorkbenchDiffTarget | null {
  return diffStore.raw.get(workspaceId)?.target ?? null
}

export function setControlledPaneFocus(layoutId: string, terminalId: string | null): void {
  paneFocusStore.set(layoutId, terminalId)
}

export function getControlledPaneFocus(layoutId: string): string | null {
  return paneFocusStore.raw.get(layoutId) ?? null
}

export function useWorkbenchDiffTarget(workspaceId: string): WorkbenchDiffTarget | null {
  return diffStore.useKey(workspaceId)?.target ?? null
}

export function useControlledPaneFocus(layoutId: string | null): string | null {
  return paneFocusStore.useKey(layoutId ?? '') ?? null
}
