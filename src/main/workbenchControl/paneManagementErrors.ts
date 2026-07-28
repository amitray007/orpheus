export class PaneProvisioningStoreError extends Error {
  constructor(
    readonly code: 'capacity' | 'conflict' | 'not_found' | 'invalid_shape',
    message: string
  ) {
    super(message)
  }
}
