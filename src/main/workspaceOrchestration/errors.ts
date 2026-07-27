import type { ControlErrorCode } from '../controlPlane/types'

export class WorkspaceOrchestrationError extends Error {
  readonly code: ControlErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: ControlErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'WorkspaceOrchestrationError'
    this.code = code
    this.details = details
  }
}

export function orchestrationError(
  code: ControlErrorCode,
  message: string,
  details?: Record<string, unknown>
): WorkspaceOrchestrationError {
  return new WorkspaceOrchestrationError(code, message, details)
}
