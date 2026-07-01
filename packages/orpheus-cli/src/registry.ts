/**
 * registry.ts — Command registry for the Orpheus CLI.
 *
 * This is a LEAF module: it has no imports of command modules and no heavy
 * dependencies. The registry Map is initialized at module load time, so it is
 * guaranteed to exist before any command module's registerCommand() call runs —
 * regardless of how esbuild or any CJS bundler orders module initialization.
 *
 * Dependency graph: command-modules → registry.ts (leaf)
 *                   cli.ts → registry.ts + command-modules
 *
 * This separation is intentional and must be preserved. Do NOT import command
 * modules from this file.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of parsed flags. Values are string (single or last-wins) or boolean. */
export type ParsedFlags = Record<string, string | boolean | string[]> & {
  /** Flag tokens the parser didn't recognize at all (neither global nor per-command). */
  _unknown?: string[]
  /** Names of string-valued flags whose value token was missing or flag-shaped. */
  _missingValue?: string[]
  /**
   * Names of boolean-valued flags given in `--flag=value` form where value
   * was neither 'true' nor 'false' (e.g. `--json=garbage`). main() turns this
   * into a usage error (exit 2) — see the "--json=<value> parsing" fix.
   */
  _invalidBooleanValue?: string[]
}

/** Context passed to every command handler. */
export type CommandContext = {
  /** Positional arguments that follow the command path. */
  positionals: string[]
  /** All flags (global + per-command), merged. */
  flags: ParsedFlags
  /** Value of --project (convenience alias for flags.project as string). */
  project: string | undefined
  /** True if --json was passed. */
  jsonMode: boolean
}

/** Flag declaration for a command: name → 'boolean' | 'string'. */
export type FlagDeclarations = Record<string, 'boolean' | 'string'>

export type CommandDescriptor = {
  /**
   * Per-command flag declarations. These are merged with the global flags
   * before the handler is called so the handler sees everything in ctx.flags.
   */
  flags?: FlagDeclarations
  /** Whether this is a read-only command (bypasses auto-launch). */
  isRead?: boolean
  /**
   * Optional explicit usage/help text shown for `<cmd> --help`. If omitted,
   * help is synthesized from the command name + declared flags/arity.
   * Command modules may populate this in a follow-up; the mechanism here
   * works with or without it.
   */
  usage?: string
  /**
   * Optional one-line description shown alongside synthesized help.
   */
  help?: string
  /**
   * Optional arity bounds on positional argument count. When declared, the
   * CLI enforces it (usage error, exit 2, if violated) before the handler
   * runs. When omitted, no positional-count enforcement happens — command
   * modules that haven't declared arity yet are unaffected.
   */
  minPositionals?: number
  maxPositionals?: number
  handler: (ctx: CommandContext) => Promise<void>
}

// ---------------------------------------------------------------------------
// Registry — initialized at module load, before any command module runs
// ---------------------------------------------------------------------------

const registry = new Map<string, CommandDescriptor>()

/**
 * Register a command handler.
 * Name is the full command path joined with spaces, e.g. 'ws new', 'project ls'.
 * Single-word commands like 'whoami' are also valid.
 *
 * Called by command modules as an ESM import side-effect. Because registry.ts
 * is a leaf module (imported by command modules, not the other way around),
 * the Map is always initialized before any call reaches here.
 */
export function registerCommand(name: string, descriptor: CommandDescriptor): void {
  registry.set(name, descriptor)
}

/** Look up a command by its full path. */
export function getCommand(name: string): CommandDescriptor | undefined {
  return registry.get(name)
}

/** Check whether a command path is registered. */
export function hasCommand(name: string): boolean {
  return registry.has(name)
}

/** Return the registry Map for iteration (e.g. longest-prefix matching). */
export function getRegistry(): ReadonlyMap<string, CommandDescriptor> {
  return registry
}
