// ---------------------------------------------------------------------------
// footerPlaceholders.ts — expand {sessionId}, {workspaceId}, {cwd},
// {workspaceName} tokens in footer action text/prompt fields before passing
// to the action registry.
// ---------------------------------------------------------------------------

export function expandPlaceholders(
  text: string,
  ctx: {
    sessionId: string | null
    workspaceId: string
    cwd: string
    workspaceName?: string
  }
): string {
  return text
    .replaceAll('{sessionId}', ctx.sessionId ?? '')
    .replaceAll('{workspaceId}', ctx.workspaceId)
    .replaceAll('{cwd}', ctx.cwd)
    .replaceAll('{workspaceName}', ctx.workspaceName ?? '')
}
