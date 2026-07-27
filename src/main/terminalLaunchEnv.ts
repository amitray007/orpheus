/**
 * Prepare the explicit environment overlay for a terminal surface launch.
 *
 * libghostty inherits the Electron main process environment, then applies the
 * strings supplied through mount opts.env. An ambient NO_COLOR therefore
 * reaches every surface even when Orpheus did not configure it, and an empty
 * string cannot neutralize consumers that check for key presence.
 *
 * Remove the ambient key immediately before the native mount and intentionally
 * do not restore it: libghostty may finish child creation after mount returns,
 * so restoring would reintroduce the race. Explicit surface env remains
 * authoritative because it is cloned unchanged and applied by libghostty after
 * inheritance; a configured NO_COLOR value (including an empty string) is
 * therefore preserved exactly.
 */
export function prepareTerminalLaunchEnv(
  explicitEnv: Readonly<Record<string, string>>,
  ambientEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  delete ambientEnv.NO_COLOR
  return { ...explicitEnv }
}
