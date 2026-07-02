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

/**
 * Rich flag metadata — DECISION: agent-first help requires more than
 * boolean-vs-string. FlagSpec carries the full agent-facing contract for a
 * flag: what it does (desc), what values it accepts (values, for enums),
 * how its value is described in usage (valueHint), what happens if you don't
 * pass it (default), and any extra behavioral caveat (notes). This is the
 * single source of truth consumed by both the parser (via flagType()) and
 * the help renderers (cli.ts commandHelp, help-model.ts).
 */
export type FlagSpec = {
  /** Parser-relevant kind — same meaning as the legacy FlagDeclarations value. */
  type: 'boolean' | 'string'
  /** One-line description of what the flag does. */
  desc: string
  /** Accepted enum values, if the flag's string value is a closed set. */
  values?: string[]
  /** Placeholder shown for the flag's value in usage lines, e.g. '<mode>'. */
  valueHint?: string
  /** Default value/behavior when the flag is omitted, as prose or a literal. */
  default?: string
  /** Extra behavioral notes/caveats that don't fit desc/default/values. */
  notes?: string
}

/**
 * Flag declaration for a command: name → 'boolean' | 'string' (legacy form,
 * still fully supported by the parser) OR name → FlagSpec (rich form, used
 * for agent-facing help). BACKWARD COMPATIBILITY: the parser and the arity/
 * help machinery never read `.type` off a plain string — they always go
 * through flagType() below, which accepts either shape. This lets command
 * modules migrate to FlagSpec incrementally without breaking anything that
 * hasn't been converted yet.
 */
export type FlagDeclarations = Record<string, 'boolean' | 'string' | FlagSpec>

/**
 * Resolve the parser-relevant kind ('boolean' | 'string') of a flag
 * declaration, regardless of whether it's the legacy shorthand or a rich
 * FlagSpec. This is the ONLY function the parser (cli.ts parseArgv) and the
 * arity/help code should use to ask "is this flag boolean or string" — never
 * inspect the declaration directly, since it may be either shape.
 */
export function flagType(spec: 'boolean' | 'string' | FlagSpec): 'boolean' | 'string' {
  return typeof spec === 'string' ? spec : spec.type
}

/** True if a flag declaration carries rich FlagSpec metadata (desc/values/etc). */
export function isFlagSpec(spec: 'boolean' | 'string' | FlagSpec): spec is FlagSpec {
  return typeof spec !== 'string'
}

/** Rich description of a single positional argument, for agent-facing help. */
export type ArgSpec = {
  /** Display name, e.g. 'id', 'text'. */
  name: string
  /** Whether this positional is required (false = optional, e.g. `[text]`). */
  required: boolean
  /** One-line description of what this argument is / does. */
  desc: string
  /** Accepted enum values, if this positional is a closed set. */
  values?: string[]
  /** Set for a trailing variadic positional, e.g. `<id...>` (ws wait, ws archive). */
  variadic?: boolean
}

export type CommandDescriptor = {
  /**
   * Per-command flag declarations. These are merged with the global flags
   * before the handler is called so the handler sees everything in ctx.flags.
   * May be the legacy 'boolean'|'string' shorthand or the rich FlagSpec —
   * see FlagDeclarations.
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
   * Optional paragraph of additional detail beyond the one-line `help`
   * summary — shown in rich `-h` output and in `orpheus help`/`ai schema`.
   */
  longDesc?: string
  /**
   * Optional rich description of this command's positional arguments (in
   * order). Purely descriptive — does not affect arity enforcement, which
   * still comes from minPositionals/maxPositionals.
   */
  argsSpec?: ArgSpec[]
  /**
   * Optional agent-oriented example invocations (full command lines,
   * without the leading 'orpheus' if the caller prefers, though including it
   * is recommended for copy-paste-ability). Shown in rich `-h` output and in
   * `orpheus help`/`ai skill`/`ai schema`.
   */
  examples?: string[]
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
