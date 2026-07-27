import type { ControlErrorCode } from '../controlPlane/types'

export class TerminalObservationError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'TerminalObservationError'
  }
}

export function terminalObservationError(
  code: ControlErrorCode,
  message: string
): TerminalObservationError {
  return new TerminalObservationError(code, message)
}
