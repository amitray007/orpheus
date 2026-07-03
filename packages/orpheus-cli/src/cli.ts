/**
 * cli.ts — Orpheus CLI entrypoint, arg parser, command registry, and auto-launch.
 *
 * LAYOUT DECISION
 * ---------------
 * src/index.ts  → lib barrel (re-exports the public programmatic API).
 *                 Unchanged; importable by other packages or tests.
 * src/cli.ts    → CLI entry (this file). Exports main(argv) for the U13 shim.
 *                 The U13 shim (Electron-as-node) calls main(process.argv.slice(2)).
 *
 * COMMAND REGISTRY
 * ----------------
 * Each command is registered as:
 *
 *   registry.set('ws new', {
 *     flags: { flag-name: 'boolean' | 'string' },  // optional, per-command flags
 *     handler: async (ctx) => { ... },
 *   })
 *
 * Where ctx is a CommandContext:
 *
 *   type CommandContext = {
 *     positionals: string[]          // positional args after the command path
 *     flags: ParsedFlags             // global + per-command flags merged
 *     project: string | undefined    // value of --project flag (global)
 *     jsonMode: boolean              // true if --json was passed
 *   }
 *
 * Later units (U7–U13) call registerCommand(name, descriptor) to add handlers.
 * The name is the full command path joined with spaces (e.g. 'ws new', 'project ls').
 *
 * ARG PARSING
 * -----------
 * Minimal hand-rolled parser. No framework dependency.
 *
 *   orpheus [global-flags] <command> [subcommand] [positionals] [per-command flags]
 *
 * Global flags:
 *   --json              boolean  Emit JSON output
 *   --project <value>   string   Set project context (id, name, or path)
 *
 * Per-command flags are declared in the command descriptor and parsed the same way.
 * Unknown flags are collected in flags._unknown (array of strings) during parsing;
 * main() rejects the invocation (usage error, exit 2) if that array is non-empty —
 * see the "strictness" note below.
 *
 * STRICTNESS
 * ----------
 * The CLI is intentional about rejecting malformed invocations rather than
 * silently doing the wrong thing:
 *   - Unknown flags (anything not in GLOBAL_FLAGS or the resolved command's
 *     declared flags) are a usage error, not silently ignored.
 *   - `--project` requires a value; if the next token is missing or looks like
 *     a flag (starts with '-'), it's a usage error rather than swallowing the
 *     next positional/command token as the project value.
 *   - Commands may declare `minPositionals`/`maxPositionals` on their
 *     CommandDescriptor; extra/missing positionals are a usage error when
 *     declared. (Undeclared arity is not enforced — see registry.ts.)
 *   - Boolean flags given in `--flag=value` form (e.g. `--json=true`) accept
 *     'true'/'false' (case-insensitive); any other value (e.g. `--json=garbage`)
 *     is a usage error rather than being silently coerced to a truthy string.
 *     Bare `--json` (no `=value`) is unaffected and still sets the flag true.
 *
 * VERSION
 * -------
 * Sourced from packages/orpheus-cli/package.json's "version" field via a JSON
 * import (tsconfig has resolveJsonModule: true). esbuild inlines the JSON at
 * bundle time (see build:cli in the root package.json), so the bundled
 * dist/cli.cjs has no runtime dependency on package.json being present next to
 * it — the string is baked in at build time. Keep package.json#version as the
 * single source of truth; nothing else needs to change to keep --version in sync.
 *
 * READS vs ACTIONS (auto-launch policy)
 * ----------------------------------------
 * Read commands (ls, status, read, whoami, project ls/show) go straight to disk
 * (sqlite / JSONL) and NEVER trigger auto-launch.
 * Action commands that call sendCommand() may get AppNotRunningError; the CLI then
 * auto-launches the app (open -a "Orpheus" / "Orpheus Dev") and retries once.
 *
 * EXIT CODES
 * ----------
 *   0  success
 *   1  general error
 *   2  usage / arg parsing error
 *   3  data not found (includes ProjectNotFoundError from an explicit
 *      --project value that didn't resolve — see context.ts and the
 *      ProjectNotFoundError handling in main()'s catch block, QA fix #2)
 *  10+ reserved for ws wait (U11)
 */

import { spawn } from 'node:child_process'
import * as net from 'node:net'
import { AppNotRunningError, CommandError } from './socket-client.js'
import { OrpheusDataNotFoundError, openDb } from './reads/db.js'
import { resolveContext, ProjectNotFoundError } from './context.js'
import { getCmdSockPath } from './paths.js'
import {
  setJsonMode,
  printError,
  printUsageError,
  printNotFoundError,
  printResult,
  printKeyValue
} from './output.js'
import { registerCommand, getCommand, hasCommand, getRegistry, flagType } from './registry.js'
import type { ParsedFlags, CommandContext, FlagDeclarations } from './registry.js'
// commandHelp is the rich single-command help renderer, extracted to its own
// module so commands/help.ts can use it without importing cli.ts (which
// itself imports commands/* for registration — that was a circular import).
import { commandHelp } from './command-help.js'
// VERSION is sourced directly from this package's package.json (single source
// of truth). esbuild bundles JSON imports as inline object literals, so the
// version string is baked into dist/cli.cjs at build time — see build:cli.
import pkg from '../package.json' with { type: 'json' }

const VERSION: string = pkg.version
// Re-export types so existing importers of cli.ts continue to work.
export type {
  ParsedFlags,
  CommandContext,
  FlagDeclarations,
  CommandDescriptor,
  FlagSpec,
  ArgSpec
} from './registry.js'
// Command implementations — each module imports from registry.ts (a leaf) and
// calls registerCommand() as an ESM side-effect. Importing registry.ts first
// here ensures the Map is initialized, but even without this explicit ordering
// the leaf module guarantees the Map is ready before any registerCommand call.
import './commands/ws-new.js'
import './commands/ws-lifecycle.js'
import './commands/ws-read.js'
import './commands/ws-ls.js'
import './commands/ws-status.js'
import './commands/ws-wait.js'
import './commands/ws-send.js'
import './commands/project.js'
// help.ts / ai.ts are the agent-facing documentation layer (see help-model.ts
// for the shared doc model both are built from). Imported last since they
// introspect the already-registered commands above via getRegistry() at
// command-invocation time (not at import time), so import order relative to
// the command modules above doesn't matter for correctness — kept last here
// only for readability (documentation commands after the "real" commands).
import './commands/help.js'
import './commands/ai.js'

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

const GLOBAL_FLAGS: FlagDeclarations = {
  json: 'boolean',
  project: 'string',
  help: 'boolean',
  version: 'boolean'
}

type ParseResult = {
  commandPath: string | null // joined with space, e.g. 'ws new'
  positionals: string[]
  flags: ParsedFlags
  project: string | undefined
  jsonMode: boolean
}

/** Short-flag aliases: -j/-p/-h/-v → --json/--project/--help/--version. */
const SHORT_FLAG_MAP: Record<string, string> = {
  j: 'json',
  p: 'project',
  h: 'help',
  v: 'version'
}

/**
 * True if `token` looks like a flag rather than a value a string flag could
 * consume — i.e. it starts with '-' (covers both '--foo' and '-f'). Used to
 * detect a missing value for string flags in general: if the next token is
 * absent or flag-shaped, we must not silently swallow it as the value.
 */
function looksLikeFlag(token: string | undefined): boolean {
  return token == null || token.startsWith('-')
}

/**
 * True if `token` is (the first word of) a registered command path, e.g.
 * 'ws' (prefix of 'ws new'/'ws ls'/...), 'project' (prefix of 'project ls'),
 * or 'whoami' (a full command on its own). Used only for --project's value
 * heuristic (#11): --project's value should never accidentally swallow a
 * command token like `orpheus --project ws ls`.
 */
function looksLikeCommandToken(token: string | undefined): boolean {
  if (token == null) return false
  for (const path of getRegistry().keys()) {
    const firstWord = path.split(' ')[0]
    if (firstWord === token) return true
  }
  return false
}

/**
 * True if `next` is unusable as the value for string flag `name` — i.e. it's
 * missing, flag-shaped, or (for --project specifically, per #11) shaped like
 * a command token. Other string flags (--task, --name, --model, ...) only
 * apply the flag-shaped/missing check, since their free-text values may
 * legitimately collide with command words.
 */
function isMissingValueFor(name: string, next: string | undefined): boolean {
  if (looksLikeFlag(next)) return true
  if (name === 'project' && looksLikeCommandToken(next)) return true
  return false
}

/**
 * Parse a `--flag=value` value for a BOOLEAN flag. Accepts 'true'/'false'
 * (case-insensitive) for convenience (`--json=true`, `--json=false`); any
 * other value (e.g. `--json=garbage`) is invalid — the boolean flag's =value
 * form is otherwise silently swallowed/misinterpreted, which is the bug this
 * fixes (#6). Returns null for an invalid value.
 */
function parseBooleanFlagValue(v: string): boolean | null {
  const lower = v.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  return null
}

/**
 * Parse argv (already stripped of node/electron/script path, so starting at
 * the first user token). Extracts global flags, resolves the command path
 * by matching registered commands (longest match first), then collects
 * remaining positionals and per-command flags.
 *
 * Flags requiring a value whose value token is missing or flag-shaped are
 * recorded in flags._missingValue (array of flag names) rather than silently
 * consuming the next token — main() turns this into a usage error (#11).
 *
 * Boolean flags given in `--flag=value` form (e.g. `--json=true`) are parsed
 * as true/false (case-insensitive); any other value is recorded in
 * flags._invalidBooleanValue rather than being silently accepted as a
 * truthy string — main() turns this into a usage error too (#6).
 */
function parseArgv(argv: string[], perCommandFlags: FlagDeclarations): ParseResult {
  const allFlags: FlagDeclarations = { ...GLOBAL_FLAGS, ...perCommandFlags }
  const flags: ParsedFlags = {}
  const args: string[] = []
  const missingValue: string[] = []
  const invalidBooleanValue: string[] = []

  // The parser only cares about boolean-vs-string, never the rich FlagSpec
  // fields — flagType() normalizes both the legacy shorthand and FlagSpec to
  // that, so this loop works unchanged regardless of which form a command
  // declares its flags in (see registry.ts's FlagSpec/flagType doc).
  const kindOf = (name: string): 'boolean' | 'string' | undefined => {
    const decl = allFlags[name]
    return decl == null ? undefined : flagType(decl)
  }

  let i = 0
  while (i < argv.length) {
    const token = argv[i]!
    if (token === '--') {
      // Everything after -- is a positional
      args.push(...argv.slice(i + 1))
      break
    }
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const eqIdx = name.indexOf('=')
      if (eqIdx !== -1) {
        // --key=value
        const k = name.slice(0, eqIdx)
        const v = name.slice(eqIdx + 1)
        if (kindOf(k) === 'boolean') {
          // Boolean flag in =value form: accept true/false, reject anything else (#6).
          const parsed = parseBooleanFlagValue(v)
          if (parsed == null) {
            invalidBooleanValue.push(k)
          } else {
            flags[k] = parsed
          }
        } else {
          flags[k] = v
        }
        i++
      } else if (kindOf(name) === 'string') {
        // --key value — the value must not be missing, another flag, or (for
        // --project) a command token (#11)
        const next = argv[i + 1]
        if (!isMissingValueFor(name, next)) {
          flags[name] = next!
          i += 2
        } else {
          missingValue.push(name)
          i++
        }
      } else if (kindOf(name) === 'boolean') {
        flags[name] = true
        i++
      } else {
        // Unknown flag — stash in _unknown
        if (!Array.isArray(flags._unknown)) flags._unknown = []
        flags._unknown.push(token)
        i++
      }
    } else if (token.startsWith('-') && token.length === 2) {
      // Short flag: -j/-p/-h/-v → --json/--project/--help/--version
      const expanded = SHORT_FLAG_MAP[token[1]!]
      if (expanded != null) {
        if (kindOf(expanded) === 'string') {
          const next = argv[i + 1]
          if (!isMissingValueFor(expanded, next)) {
            flags[expanded] = next!
            i += 2
          } else {
            missingValue.push(expanded)
            i++
          }
        } else {
          flags[expanded] = true
          i++
        }
      } else {
        if (!Array.isArray(flags._unknown)) flags._unknown = []
        flags._unknown.push(token)
        i++
      }
    } else {
      args.push(token)
      i++
    }
  }

  if (missingValue.length > 0) {
    flags._missingValue = missingValue
  }
  if (invalidBooleanValue.length > 0) {
    flags._invalidBooleanValue = invalidBooleanValue
  }

  // Resolve command path via longest prefix match against registered commands.
  // At call time we may not yet know per-command flags, so we do a two-pass:
  // first pass resolves the path, second pass re-parses if needed.
  // Here we attempt longest match from the args array.
  let commandPath: string | null = null
  let positionals: string[] = args

  for (let len = Math.min(args.length, 3); len >= 1; len--) {
    const candidate = args.slice(0, len).join(' ')
    if (hasCommand(candidate)) {
      commandPath = candidate
      positionals = args.slice(len)
      break
    }
  }

  return {
    commandPath,
    positionals,
    flags,
    project: typeof flags.project === 'string' ? flags.project : undefined,
    jsonMode: flags.json === true
  }
}

/**
 * Full two-pass parse: first parse to find the command (using global flags
 * only), then re-parse with per-command flags merged in.
 */
function fullParse(argv: string[]): ParseResult {
  // Pass 1: global flags only, to find the command
  const pass1 = parseArgv(argv, {})
  const cmd = pass1.commandPath != null ? getCommand(pass1.commandPath) : undefined
  const perCmdFlags = cmd?.flags ?? {}
  // Pass 2: with per-command flags added
  return parseArgv(argv, perCmdFlags)
}

// ---------------------------------------------------------------------------
// Auto-launch
// ---------------------------------------------------------------------------

/** Detect the app name from the same env var used by paths.ts */
function resolveAppName(): string {
  const variant = process.env.ORPHEUS_DATA_VARIANT
  if (variant === 'dev') return 'Orpheus Dev'
  return 'Orpheus'
}

/**
 * Probe whether the command socket is reachable by attempting a TCP connection.
 * Resolves true if connectable within timeoutMs, false otherwise.
 */
function probeSocket(sockPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(sockPath)
    const timer = setTimeout(() => {
      sock.destroy()
      resolve(false)
    }, timeoutMs)
    sock.once('connect', () => {
      clearTimeout(timer)
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/**
 * Spawn the Orpheus app (detached) and wait for the command socket to become
 * reachable, up to totalTimeoutMs. Returns when the socket is available or
 * throws an error if the timeout elapses.
 */
async function autoLaunch(totalTimeoutMs = 15_000): Promise<void> {
  const appName = resolveAppName()
  const sockPath = getCmdSockPath()

  // Spawn detached — we don't want the CLI to own the app process lifecycle
  spawn('open', ['-a', appName], {
    detached: true,
    stdio: 'ignore'
  }).unref()

  const pollIntervalMs = 500
  const deadline = Date.now() + totalTimeoutMs

  while (Date.now() < deadline) {
    const reachable = await probeSocket(sockPath, pollIntervalMs)
    if (reachable) return
    // Wait before next probe (don't hammer the socket)
    await new Promise<void>((r) => setTimeout(r, pollIntervalMs))
  }

  throw new AppNotRunningError(
    `could not reach Orpheus after launching "${appName}" (timed out after ${totalTimeoutMs / 1000}s)`
  )
}

// ---------------------------------------------------------------------------
// Built-in commands — implemented here in U6
// ---------------------------------------------------------------------------

/**
 * whoami — resolve context and print { workspaceId, projectId, projectName, cwd }.
 * Pure read: opens DB directly, never triggers auto-launch.
 */
async function handleWhoami(ctx: CommandContext): Promise<void> {
  const db = openDb()
  try {
    const resolved = resolveContext({ project: ctx.project }, db)
    let projectName: string | null = null
    if (resolved.projectId != null) {
      const proj = db.getProjectFull(resolved.projectId)
      projectName = proj?.name ?? null
    }

    const result = {
      workspaceId: resolved.workspaceId,
      projectId: resolved.projectId,
      projectName,
      cwd: resolved.cwd
    }

    printResult(result, () => {
      printKeyValue(result as Record<string, unknown>)
    })
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Register built-in commands
// ---------------------------------------------------------------------------

registerCommand('whoami', {
  isRead: true,
  // No positional args accepted (#12: reject `whoami extra junk`).
  minPositionals: 0,
  maxPositionals: 0,
  help: 'Show current project/workspace context',
  longDesc:
    'A pure read (never triggers auto-launch). Resolves context the same way every ' +
    'other command does (--project flag, then ORPHEUS_WORKSPACE_ID, then cwd match) ' +
    'and prints { workspaceId, projectId, projectName, cwd } — useful to sanity-check ' +
    'what project/workspace an agent invocation will resolve to before running an ' +
    'action command.',
  examples: ['orpheus whoami', 'orpheus --json whoami | jq .projectId'],
  handler: handleWhoami
})

// All commands are now implemented in their own modules (imported at the top of
// this file). Each module calls registerCommand() as an ESM side-effect.
//
// ws commands (U7-U10, U11 for ws wait, U12 for ws send)
// 'ws new'     is registered by src/commands/ws-new.ts (imported at top of file)
// 'ws open'    is registered by src/commands/ws-lifecycle.ts (imported at top of file)
// 'ws archive' is registered by src/commands/ws-lifecycle.ts (imported at top of file)
// 'ws close'   is registered by src/commands/ws-lifecycle.ts (imported at top of file)
// 'ws reopen'  is registered by src/commands/ws-lifecycle.ts (imported at top of file)
// 'ws rename'  is registered by src/commands/ws-lifecycle.ts (imported at top of file)
// 'ws ls'      is registered by src/commands/ws-ls.ts (imported at top of file)
// 'ws status'  is registered by src/commands/ws-status.ts (imported at top of file)
// 'ws read'    is registered by src/commands/ws-read.ts (imported at top of file)
// 'ws wait'    is registered by src/commands/ws-wait.ts (imported at top of file)
// 'ws send'    is registered by src/commands/ws-send.ts (imported at top of file)

// 'project ls' and 'project show' are registered by src/commands/project.ts (imported at top of file)

// ---------------------------------------------------------------------------
// Usage / help
// ---------------------------------------------------------------------------

const USAGE = `
Orpheus CLI

Command-line interface for the Orpheus app — inspect and drive projects and
workspaces from the terminal.

Usage:
  orpheus [--json] [--project <id|name|path>] <command> [args] [flags]
  orpheus <command> -h | --help
  orpheus -h | --help
  orpheus -v | --version

Options:
  --json              Emit JSON output (stable, machine-readable)
  --project <val>     Set project context by id, name, or path
  -h, --help          Show help (top-level, or for a specific command)
  -v, --version       Show CLI version

Commands:
  whoami              Show current project/workspace context
  ws new              Create a new workspace
  ws open             Open a workspace in the app
  ws archive          Archive one or more workspaces
  ws close            Close a workspace
  ws reopen           Reopen a closed workspace
  ws rename           Rename a workspace
  ws ls               List workspaces
  ws status           Show workspace activity
  ws read             Read workspace transcript
  ws wait             Wait for workspace(s) to reach a terminal state
  ws send             Send input to a workspace
  project ls          List projects
  project show        Show project details
  help                Show full CLI reference (text/md/json)
  ai skill            Agent playbook for orchestrating via this CLI
  ai schema           Machine-readable CLI schema (JSON)

Run 'orpheus <command> --help' for rich help on a specific command, or
'orpheus help --format md' for the full agent-facing reference.

Exit codes:
  0   success
  1   general error
  2   usage / argument error
  3   not found
  10  ws wait: blocked on a permission prompt
  11  ws wait: blocked on user input
  12  ws wait: timed out
  13  ws wait: session died / app not running
`.trimStart()

// ---------------------------------------------------------------------------
// Main entrypoint — exported for the U13 shim
// ---------------------------------------------------------------------------

/**
 * Main CLI entrypoint. Called by the U13 Electron-as-node shim as:
 *   main(process.argv.slice(2))
 *
 * The argv parameter should already be stripped of the node/electron binary
 * path and the script path — i.e. it starts at the first user-visible token.
 */
export async function main(argv: string[]): Promise<void> {
  const parsed = fullParse(argv)

  // Apply global output mode immediately
  setJsonMode(parsed.jsonMode)

  const helpRequested = parsed.flags.help === true

  // --help/-h WITH a resolved command → print that command's help (#10),
  // regardless of other flag/arity problems (help always wins for a known command).
  if (helpRequested && parsed.commandPath != null) {
    const descriptor = getCommand(parsed.commandPath)!
    process.stdout.write(commandHelp(parsed.commandPath, descriptor))
    process.exitCode = 0
    return
  }

  // Bare --help/-h → top-level usage. Exit 0: help was explicitly requested.
  if (helpRequested) {
    process.stdout.write(USAGE)
    process.exitCode = 0
    return
  }

  // --version/-v (checked before the "bare invocation" fallback below, since
  // `orpheus --version` has zero argv tokens' worth of command/positionals
  // but must not be treated as a bare invocation)
  if (parsed.flags.version === true) {
    if (parsed.jsonMode) {
      process.stdout.write(JSON.stringify({ version: VERSION }) + '\n')
    } else {
      process.stdout.write(`${VERSION}\n`)
    }
    process.exitCode = 0
    return
  }

  // Truly bare invocation (no argv at all) → top-level usage, exit 0.
  if (argv.length === 0) {
    process.stdout.write(USAGE)
    process.exitCode = 0
    return
  }

  // Unknown flags are a usage error, not silently ignored (#6 — strictness).
  if (Array.isArray(parsed.flags._unknown) && parsed.flags._unknown.length > 0) {
    const names = parsed.flags._unknown.join(', ')
    const hint =
      parsed.commandPath != null
        ? `Run 'orpheus ${parsed.commandPath} -h' for usage.`
        : `Run 'orpheus -h' for usage.`
    printUsageError(`unknown flag: ${names}. ${hint}`)
    return
  }

  // A string flag (e.g. --project) was given without a usable value (#11).
  if (Array.isArray(parsed.flags._missingValue) && parsed.flags._missingValue.length > 0) {
    const [first] = parsed.flags._missingValue
    printUsageError(`flag --${first} requires a value`)
    return
  }

  // A boolean flag (e.g. --json) was given in `--flag=value` form with a value
  // that isn't 'true'/'false' (#6, e.g. `--json=garbage`).
  if (
    Array.isArray(parsed.flags._invalidBooleanValue) &&
    parsed.flags._invalidBooleanValue.length > 0
  ) {
    const [first] = parsed.flags._invalidBooleanValue
    printUsageError(`flag --${first} must be --${first}, --${first}=true, or --${first}=false`)
    return
  }

  // Unknown command
  if (parsed.commandPath == null) {
    const attempted = parsed.positionals.slice(0, 2).join(' ')
    printUsageError(
      `unknown command: ${attempted || '(none)'}. Run 'orpheus -h' for a list of commands.`
    )
    return
  }

  const descriptor = getCommand(parsed.commandPath)!

  // Arity checking (#12): only enforced when the descriptor declares it.
  const positionalCount = parsed.positionals.length
  if (descriptor.minPositionals != null && positionalCount < descriptor.minPositionals) {
    printUsageError(
      `${parsed.commandPath} expects at least ${descriptor.minPositionals} argument(s), got ${positionalCount}. Run 'orpheus ${parsed.commandPath} -h' for usage.`
    )
    return
  }
  if (descriptor.maxPositionals != null && positionalCount > descriptor.maxPositionals) {
    printUsageError(
      `${parsed.commandPath} expects at most ${descriptor.maxPositionals} argument(s), got ${positionalCount}. Run 'orpheus ${parsed.commandPath} -h' for usage.`
    )
    return
  }

  const ctx: CommandContext = {
    positionals: parsed.positionals,
    flags: parsed.flags,
    project: parsed.project,
    jsonMode: parsed.jsonMode
  }

  try {
    await descriptor.handler(ctx)
  } catch (err: unknown) {
    // Explicit --project value that didn't resolve to any project (QA fix #2).
    // Checked FIRST, ahead of the AppNotRunningError auto-launch branch below:
    // a bad --project value is a data problem, not an "app isn't running yet"
    // problem, so it must never trigger auto-launch. Exit 3, distinct from the
    // generic noProjectMessage() usage error (exit 2) used when --project was
    // never given at all.
    if (err instanceof ProjectNotFoundError) {
      printNotFoundError(err.message)
      return
    }
    // Read commands get no auto-launch; action commands that hit AppNotRunningError
    // trigger auto-launch then retry.
    if (err instanceof AppNotRunningError && descriptor.isRead !== true) {
      try {
        await autoLaunch()
        // Retry the command once after the app is reachable
        await descriptor.handler(ctx)
      } catch (retryErr: unknown) {
        if (retryErr instanceof ProjectNotFoundError) {
          printNotFoundError(retryErr.message)
        } else if (retryErr instanceof AppNotRunningError) {
          printError(retryErr)
        } else if (retryErr instanceof CommandError) {
          printError(retryErr)
        } else if (retryErr instanceof OrpheusDataNotFoundError) {
          printNotFoundError(retryErr.message)
        } else {
          printError(retryErr)
        }
      }
    } else if (err instanceof OrpheusDataNotFoundError) {
      printNotFoundError(err.message)
    } else if (err instanceof AppNotRunningError) {
      // Read command hit AppNotRunningError — shouldn't happen for true reads,
      // but handle gracefully just in case
      printError(err)
    } else if (err instanceof CommandError) {
      printError(err)
    } else {
      printError(err)
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point invocation
// ---------------------------------------------------------------------------
// This bundle is only ever executed as the CLI entry point (never imported as a
// library — src/index.ts is the lib barrel). Call main unconditionally so it
// runs when the CJS bundle is executed via:
//   exec "$ELECTRON_BIN" "$CLI_BUNDLE" "$@"   (with ELECTRON_RUN_AS_NODE=1)
// Under ELECTRON_RUN_AS_NODE, argv is [electronBin, bundlePath, ...userArgs],
// so process.argv.slice(2) correctly strips the runtime prefix.
main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`orpheus: fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
