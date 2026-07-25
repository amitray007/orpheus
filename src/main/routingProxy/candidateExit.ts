/**
 * Marks an intentionally terminated readiness-failure candidate before its
 * active-start marker is removed. An exit emitted at either side of that
 * transition is therefore consumed as expected, while callers retain their
 * PID/generation ownership checks outside this narrow policy.
 */
export function markFailedCandidateTermination(
  expectedTerminationPids: Set<number>,
  activeStartingCandidatePids: Set<number>,
  pid: number
): void {
  expectedTerminationPids.add(pid)
  activeStartingCandidatePids.delete(pid)
}

/** Consumes only the exiting candidate's exact expected-start/termination marker. */
export function consumeExpectedCandidateExit(
  expectedTerminationPids: Set<number>,
  activeStartingCandidatePids: Set<number>,
  pid: number
): boolean {
  const expectedTermination = expectedTerminationPids.delete(pid)
  const activeStart = activeStartingCandidatePids.delete(pid)
  return expectedTermination || activeStart
}
