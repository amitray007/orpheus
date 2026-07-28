export function nextPaneRevision(previous: number, observedNow = Date.now()): number {
  return Math.max(observedNow, previous + 1)
}
