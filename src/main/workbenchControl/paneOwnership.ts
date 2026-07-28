export function layoutMutationReleasesAgentOwner(patch: {
  dir?: string
  splitTree?: unknown
  position?: number
}): boolean {
  return patch.dir !== undefined || patch.splitTree !== undefined || patch.position !== undefined
}

export function terminalMutationReleasesAgentOwner(patch: {
  command?: string
  position?: number
}): boolean {
  return patch.command !== undefined || patch.position !== undefined
}
