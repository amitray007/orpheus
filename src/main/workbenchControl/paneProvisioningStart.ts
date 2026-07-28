type WindowBounds = { x: number; y: number; width: number; height: number }

export function resolvePaneBackgroundScaleFactor(input: {
  getWindowBounds: () => WindowBounds
  resolveDisplayScaleFactor: (bounds: WindowBounds) => number
}): number {
  const observedScaleFactor = input.resolveDisplayScaleFactor(input.getWindowBounds())
  return Number.isFinite(observedScaleFactor) && observedScaleFactor > 0 ? observedScaleFactor : 1
}

export function startProvisionedPaneSurface(input: {
  getWindowBounds: () => WindowBounds
  resolveDisplayScaleFactor: (bounds: WindowBounds) => number
  getSurfacePhase: () => string
  mount: (scaleFactor: number) => void
  hide: () => void
}): 'started' | 'retained' {
  const retained = input.getSurfacePhase() !== 'none'
  const scaleFactor = resolvePaneBackgroundScaleFactor(input)
  input.mount(scaleFactor)
  input.hide()
  return retained ? 'retained' : 'started'
}
