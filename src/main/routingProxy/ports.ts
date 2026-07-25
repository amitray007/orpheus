export const AUTOMATIC_PORT_MIN = 18765
export const AUTOMATIC_PORT_MAX = 18799

export function assertValidAutomaticRoutingProxyEffectivePort(port: number): number {
  if (!Number.isInteger(port) || port < AUTOMATIC_PORT_MIN || port > AUTOMATIC_PORT_MAX) {
    throw new Error(
      `uiState: routingProxyEffectivePort must be an integer between ${AUTOMATIC_PORT_MIN} and ${AUTOMATIC_PORT_MAX} or null`
    )
  }
  return port
}
