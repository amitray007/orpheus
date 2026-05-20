// ---------------------------------------------------------------------------
// footerPlaceholders.ts — expand {sessionId}, {workspaceId}, {cwd} tokens
// in footer action text fields before passing to the action registry.
// ---------------------------------------------------------------------------

export function expandPlaceholders(
  text: string,
  ctx: { sessionId: string | null; workspaceId: string; cwd: string }
): string {
  return text
    .replaceAll('{sessionId}', ctx.sessionId ?? '')
    .replaceAll('{workspaceId}', ctx.workspaceId)
    .replaceAll('{cwd}', ctx.cwd)
}
