const MAX_COMMAND_ACTION_LENGTH = 128

export function parseCommandAction(body: unknown): string | null {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return null
  const action = (body as Record<string, unknown>)['action']
  if (
    typeof action !== 'string' ||
    action.length < 1 ||
    action.length > MAX_COMMAND_ACTION_LENGTH ||
    action.trim() !== action
  ) {
    return null
  }
  return action
}
