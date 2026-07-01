/**
 * focus.ts — shared --focus/--background flag resolution for workspace
 * activation commands (`ws new`, `ws send`, `ws open`).
 *
 * BACKGROUND
 * ----------
 * Activating a workspace (creating+mounting its terminal surface, or
 * auto-opening it before an inject) has historically always NAVIGATED the
 * Orpheus GUI to that workspace — stealing whatever the user was looking at.
 * For agent fan-out (spawning worker workspaces from inside another workspace,
 * or driving several workspaces from a script) that's disruptive: the whole
 * point is to activate + inject WITHOUT yanking the user's view around.
 *
 * `--focus` / `--background` let a caller choose explicitly:
 *   --focus       navigate the GUI to the workspace (the historical behavior)
 *   --background  mount the workspace's terminal surface (so it becomes
 *                 injectable) WITHOUT changing what the user is looking at
 *
 * The two flags are mutually exclusive — passing both is a usage error.
 *
 * DEFAULTS (per command, deliberately different)
 * -----------------------------------------------
 *   ws new / ws send  → default --background (agent fan-out shouldn't
 *                        disturb the user by default; --focus opts in)
 *   ws open            → default --focus (an explicit "open this workspace"
 *                        command should show it; --background opts out)
 */

/**
 * Resolve the boolean `focus` value to send to the server from a command's
 * parsed --focus/--background flags, given the command's default.
 *
 * Accepts any flags-bag shape with optional focus/background entries
 * (structurally matches registry.ts's ParsedFlags, which is a
 * Record<string, string | boolean | string[]> — an index signature, so a
 * narrow standalone object type doesn't structurally overlap with it).
 *
 * Returns an error message string if both flags were passed (mutually
 * exclusive), otherwise returns the resolved boolean.
 */
export function resolveFocus(
  flags: { [key: string]: unknown },
  defaultFocus: boolean
): { ok: true; focus: boolean } | { ok: false; error: string } {
  const hasFocus = flags.focus === true
  const hasBackground = flags.background === true

  if (hasFocus && hasBackground) {
    return { ok: false, error: '--focus and --background are mutually exclusive' }
  }
  if (hasFocus) return { ok: true, focus: true }
  if (hasBackground) return { ok: true, focus: false }
  return { ok: true, focus: defaultFocus }
}
