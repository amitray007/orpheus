export type PaneSurfacePhase = 'none' | 'hidden' | 'attached' | 'visible' | 'freeing'

export function teardownPaneSurfaceStrict(input: {
  layoutId: string
  terminalId: string
  getPhase: (surfaceId: string) => PaneSurfacePhase
  isRegistered: (layoutId: string, terminalId: string) => boolean
  destroy: (surfaceId: string) => void
  unregister: (layoutId: string, terminalId: string) => void
}): 'stopped' | 'absent' {
  const surfaceId = `pane:${input.layoutId}:${input.terminalId}`
  const phase = input.getPhase(surfaceId)
  if (phase === 'none') {
    input.unregister(input.layoutId, input.terminalId)
    return 'absent'
  }
  if (phase === 'freeing') {
    if (input.isRegistered(input.layoutId, input.terminalId)) {
      throw new Error('A remounted pane surface is live while prior teardown is freeing.')
    }
    input.unregister(input.layoutId, input.terminalId)
    return 'stopped'
  }
  input.destroy(surfaceId)
  input.unregister(input.layoutId, input.terminalId)
  return 'stopped'
}
