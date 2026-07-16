/**
 * Shared helper for encoding an absolute filesystem path to the directory-name
 * format that Claude Code uses under ~/.claude/projects/.
 *
 * Claude replaces BOTH '/' AND '.' with '-'.  For example:
 *   /Users/you/.claude/worktrees/my-feature
 *   →  -Users-you--claude-worktrees-my-feature
 *
 * Normal project paths (no dots in path components) happen to work with a
 * slash-only replace, but worktree paths go through '.claude/worktrees/' so
 * the dot must also be replaced.  This module is the single source of truth;
 * claudeSettings.ts, sessions.ts, and projects.ts all import from here.
 */
export function encodePathToClaudeDir(absolutePath: string): string {
  return absolutePath.replace(/[/.]/g, '-')
}
