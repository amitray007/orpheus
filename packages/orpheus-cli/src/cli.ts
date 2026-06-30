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
 * Unknown flags are silently collected in flags._unknown (array of strings) so
 * later units can decide whether to error on them.
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
 *   3  data not found
 *  10+ reserved for ws wait (U11)
 */

import { spawn } from 'node:child_process'
import * as net from 'node:net'
import { AppNotRunningError, CommandError } from './socket-client.js'
import { OrpheusDataNotFoundError, openDb } from './reads/db.js'
import { resolveContext } from './context.js'
import { getCmdSockPath } from './paths.js'
import {
  setJsonMode,
  printError,
  printUsageError,
  printNotFoundError,
  printResult,
  printKeyValue
} from './output.js'
// Command implementations — each module calls registerCommand() as a side-effect.
// Stubs below are omitted for commands that have real implementations here.
import './commands/ws-new.js'
import './commands/ws-lifecycle.js'
import './commands/ws-read.js'
import './commands/ws-ls.js'
import './commands/ws-status.js'
import './commands/project.js'

// ---------------------------------------------------------------------------
// Command registry types
// ---------------------------------------------------------------------------

/** Shape of parsed flags. Values are string (single or last-wins) or boolean. */
export type ParsedFlags = Record<string, string | boolean | string[]> & {
  _unknown?: string[]
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
  handler: (ctx: CommandContext) => Promise<void>
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, CommandDescriptor>()

/**
 * Register a command handler.
 * Name is the full command path joined with spaces, e.g. 'ws new', 'project ls'.
 * Single-word commands like 'whoami' are also valid.
 *
 * Later units (U7–U13) call this to add their handlers.
 */
export function registerCommand(name: string, descriptor: CommandDescriptor): void {
  registry.set(name, descriptor)
}

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

/**
 * Parse argv (already stripped of node/electron/script path, so starting at
 * the first user token). Extracts global flags, resolves the command path
 * by matching registered commands (longest match first), then collects
 * remaining positionals and per-command flags.
 */
function parseArgv(argv: string[], perCommandFlags: FlagDeclarations): ParseResult {
  const allFlags: FlagDeclarations = { ...GLOBAL_FLAGS, ...perCommandFlags }
  const flags: ParsedFlags = {}
  const args: string[] = []

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
        flags[k] = v
        i++
      } else if (allFlags[name] === 'string') {
        // --key value
        if (i + 1 < argv.length) {
          flags[name] = argv[i + 1]!
          i += 2
        } else {
          flags[name] = ''
          i++
        }
      } else if (allFlags[name] === 'boolean') {
        flags[name] = true
        i++
      } else {
        // Unknown flag — stash in _unknown
        if (!Array.isArray(flags._unknown)) flags._unknown = []
        flags._unknown.push(token)
        i++
      }
    } else if (token.startsWith('-') && token.length === 2) {
      // Short flag: -j → --json, -p → --project (only a couple defined)
      const shortMap: Record<string, string> = { j: 'json', p: 'project' }
      const expanded = shortMap[token[1]!]
      if (expanded != null) {
        if (allFlags[expanded] === 'string' && i + 1 < argv.length) {
          flags[expanded] = argv[i + 1]!
          i += 2
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

  // Resolve command path via longest prefix match against registered commands.
  // At call time we may not yet know per-command flags, so we do a two-pass:
  // first pass resolves the path, second pass re-parses if needed.
  // Here we attempt longest match from the args array.
  let commandPath: string | null = null
  let positionals: string[] = args

  for (let len = Math.min(args.length, 3); len >= 1; len--) {
    const candidate = args.slice(0, len).join(' ')
    if (registry.has(candidate)) {
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
  const cmd = pass1.commandPath != null ? registry.get(pass1.commandPath) : undefined
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
  handler: handleWhoami
})

// Stub for later units — each generates a "not yet implemented (Uxx)" error.
function makeStub(unit: string): CommandDescriptor {
  return {
    handler: async (): Promise<void> => {
      throw new Error(`not yet implemented (${unit})`)
    }
  }
}

// ws commands (U7-U10, U11 for ws wait)
// 'ws new'     is registered by src/commands/ws-new.ts (imported at top of file)
// 'ws open'    is registered by src/commands/ws-lifecycle.ts (imported at top of file)
// 'ws archive' is registered by src/commands/ws-lifecycle.ts (imported at top of file)
// 'ws close'   is registered by src/commands/ws-lifecycle.ts (imported at top of file)
// 'ws reopen'  is registered by src/commands/ws-lifecycle.ts (imported at top of file)
// 'ws rename'  is registered by src/commands/ws-lifecycle.ts (imported at top of file)
// 'ws ls'      is registered by src/commands/ws-ls.ts (imported at top of file)
// 'ws status'  is registered by src/commands/ws-status.ts (imported at top of file)
// 'ws read'    is registered by src/commands/ws-read.ts (imported at top of file)
registerCommand('ws wait', makeStub('U11'))
registerCommand('ws send', makeStub('U12'))

// 'project ls' and 'project show' are registered by src/commands/project.ts (imported at top of file)

// ---------------------------------------------------------------------------
// Usage / help
// ---------------------------------------------------------------------------

const USAGE = `
Orpheus CLI

Usage:
  orpheus [--json] [--project <id|name|path>] <command> [args] [flags]

Global flags:
  --json              Emit JSON output (stable, machine-readable)
  --project <val>     Set project context by id, name, or path
  --help              Show this help text
  --version           Show CLI version

Commands:
  whoami              Show current project/workspace context
  ws new              Create a new workspace       (U7)
  ws open             Open a workspace in the app  (U7)
  ws archive          Archive a workspace          (U7)
  ws close            Close a workspace            (U7)
  ws reopen           Reopen a closed workspace    (U7)
  ws rename           Rename a workspace           (U7)
  ws ls               List workspaces              (U8)
  ws status           Show workspace activity      (U9)
  ws read             Read workspace transcript    (U10)
  ws wait             Wait for workspace to idle   (U11)
  ws send             Send input to a workspace    (U12)
  project ls          List projects                (U13)
  project show        Show project details         (U13)

Exit codes:
  0  success
  1  general error
  2  usage / argument error
  3  not found
  10-13  ws wait codes (U11)
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

  // --help or no command → print usage
  if (
    parsed.flags.help === true ||
    (parsed.commandPath == null && parsed.positionals.length === 0)
  ) {
    process.stdout.write(USAGE)
    return
  }

  // --version
  if (parsed.flags.version === true) {
    process.stdout.write('0.1.0\n')
    return
  }

  // Unknown command
  if (parsed.commandPath == null) {
    const attempted = parsed.positionals.slice(0, 2).join(' ')
    printUsageError(`unknown command: ${attempted || '(none)'}. Run with --help for usage.`)
    return
  }

  const descriptor = registry.get(parsed.commandPath)!
  const ctx: CommandContext = {
    positionals: parsed.positionals,
    flags: parsed.flags,
    project: parsed.project,
    jsonMode: parsed.jsonMode
  }

  try {
    await descriptor.handler(ctx)
  } catch (err: unknown) {
    // Read commands get no auto-launch; action commands that hit AppNotRunningError
    // trigger auto-launch then retry.
    if (err instanceof AppNotRunningError && descriptor.isRead !== true) {
      try {
        await autoLaunch()
        // Retry the command once after the app is reachable
        await descriptor.handler(ctx)
      } catch (retryErr: unknown) {
        if (retryErr instanceof AppNotRunningError) {
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
