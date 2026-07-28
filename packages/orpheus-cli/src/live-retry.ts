import { AppNotRunningError } from './socket-client.js'

/**
 * Run one live CLI operation and, only when the app connection is unavailable,
 * prepare a fresh connection and retry the whole operation exactly once.
 *
 * The caller owns connection-cache invalidation and app launch/re-resolution in
 * prepareRetry. A second failure is returned to the normal CLI error dispatcher;
 * this helper never loops.
 */
export async function runWithSingleAppRetry<T>(
  operation: () => Promise<T>,
  prepareRetry: () => Promise<void>,
  retryEnabled: boolean
): Promise<T> {
  try {
    return await operation()
  } catch (error: unknown) {
    if (!(error instanceof AppNotRunningError) || !retryEnabled) {
      throw error
    }
  }

  await prepareRetry()
  return operation()
}
