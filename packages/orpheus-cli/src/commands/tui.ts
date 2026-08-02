/**
 * commands/tui.ts — `orpheus tui` command registration.
 *
 * This module is intentionally light: it resolves --project (a plain DB
 * read, already paid for by every other command) and then LAZY-LOADS the
 * actual Ink application from dist/tui.mjs — a separate esbuild bundle (see
 * "build:cli:tui" in the root package.json) — only once this handler is
 * actually invoked. One-shot commands (`ws ls`, `whoami`, ...) never load
 * react/ink because cli.ts's single bundle (dist/cli.cjs) never statically
 * imports tui/entry.ts; see the dynamic import() call below for how that's
 * kept true even after esbuild bundles this file into dist/cli.cjs.
 *
 * WHY dist/tui.mjs IS ESM (not another .cjs, unlike dist/cli.cjs)
 * -----------------------------------------------------------------
 * Ink's reconciler (and its yoga-layout dependency, the WASM flexbox engine)
 * use top-level await internally, which esbuild cannot lower into a
 * CommonJS bundle. The TUI bundle is therefore built as ESM
 * (packages/orpheus-cli/dist/tui.mjs) and loaded via a dynamic `import()` —
 * which works from this CommonJS file just fine (Node allows `import()` from
 * CJS) and, because the path below is a COMPUTED value rather than a string
 * literal, esbuild cannot statically resolve/bundle it when it bundles this
 * file into dist/cli.cjs — it's left as a real dynamic import against the
 * file on disk at runtime. That's what keeps react/ink out of dist/cli.cjs
 * entirely.
 *
 * WHY "build:cli:tui" USES --splitting/--outdir (not a single --outfile)
 * -----------------------------------------------------------------------
 * Ink only imports its devtools integration (react-devtools-core, an
 * optional peer we don't install) behind `if (process.env.DEV === 'true')`,
 * via its OWN dynamic `import()`. Bundled into a single --outfile, esbuild
 * hoists that nested module's static imports to the top of the one bundle —
 * turning a conditional, rarely-hit dependency into one that's evaluated
 * (and fails to resolve) on every load. `--splitting --outdir` keeps that
 * chunk in its own output file, so it's only loaded if DEV=true is ever set
 * (never, for us) — see dist/devtools-*.mjs after a build.
 *
 * NOT isRead: this command talks to the running app (via tui/entry.ts's
 * subscribe() call), so a stopped app should trigger the standard
 * auto-launch + single-retry flow in cli.ts — see tui/entry.ts's file header
 * for why that Just Works without any bespoke launch code here.
 *
 * DUAL-BUNDLE `instanceof` HAZARD (why rethrowAcrossBundleBoundary exists)
 * ---------------------------------------------------------------------------
 * dist/tui.mjs is a SEPARATE esbuild bundle from dist/cli.cjs, so it has its
 * OWN copy of socket-client.ts's AppNotRunningError/CommandError classes —
 * different class objects with the same name. cli.ts's retry/dispatch logic
 * (`error instanceof AppNotRunningError`) checks against ITS OWN copy, so an
 * error thrown by code running inside tui.mjs would silently fail that
 * check (auto-launch would never fire; the error would fall through to a
 * generic message with no "Tip:" line). rethrowAcrossBundleBoundary()
 * re-wraps by `.name` at this boundary so cli.ts's instanceof checks see ITS
 * OWN class, same as every other command.
 *
 * --project
 * ---------
 * Scopes the picker to a single project and suppresses its header row (see
 * docs/REMOTE_ACCESS.md and tui/layout.ts's flattenTree). Resolved via the
 * SAME resolveContext() ladder every other --project flag uses (id, then
 * name, then filesystem path) — not a second matcher. Unlike most commands,
 * an ABSENT --project here means "show every project" (not "scope to the
 * cwd/ORPHEUS_WORKSPACE_ID project") — the TUI's whole-fleet view is the
 * default; --project is an opt-in narrowing for e.g. a Termius host entry
 * with a per-project startup command.
 */

import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerCommand } from '../registry.js'
import { openDb } from '../reads/db.js'
import { resolveContext, ProjectNotFoundError } from '../context.js'
import { printNotFoundError, printUsageError } from '../output.js'
import { AppNotRunningError, CommandError } from '../socket-client.js'
import type { ProjectScope } from '../tui/layout.js'
import type { RunTuiOptions } from '../tui/entry.js'

/** Shape of the lazily-imported dist/tui.mjs module. */
type TuiModule = { runTui: (options?: RunTuiOptions) => Promise<void> }

/**
 * Re-wrap an error crossing the dist/tui.mjs -> dist/cli.cjs boundary as THIS
 * bundle's own AppNotRunningError/CommandError class, by `.name` rather than
 * `instanceof` (which can't see across the bundle boundary — see the file
 * header's "DUAL-BUNDLE instanceof HAZARD" note). Anything else is rethrown
 * unchanged.
 */
function rethrowAcrossBundleBoundary(err: unknown): never {
  if (err instanceof Error && err.name === 'AppNotRunningError') {
    throw new AppNotRunningError(err.message)
  }
  if (err instanceof Error && err.name === 'CommandError') {
    throw new CommandError(err.message)
  }
  throw err
}

/**
 * Resolve --project into a ProjectScope, or undefined when the flag was not
 * given (the TUI's default: show every project). Returns { ok: false } when
 * an explicit --project value didn't resolve to any project — the caller
 * must print a not-found error (exit 3) and bail before touching the TUI.
 */
function resolveProjectScope(
  projectFlag: string | undefined
): { ok: true; scope: ProjectScope | undefined } | { ok: false; message: string } {
  if (projectFlag == null || projectFlag === '') {
    return { ok: true, scope: undefined }
  }

  const db = openDb()
  try {
    const resolved = resolveContext({ project: projectFlag }, db)
    // resolveContext() throws ProjectNotFoundError (caught below) when
    // --project doesn't resolve, so reaching here guarantees projectId is set.
    const project = db.getProjectFull(resolved.projectId!)
    return {
      ok: true,
      scope: { id: resolved.projectId!, name: project?.name ?? resolved.projectId! }
    }
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return { ok: false, message: err.message }
    }
    throw err
  } finally {
    db.close()
  }
}

registerCommand('tui', {
  usage: 'tui [--project <id|name|path>]',
  help: 'Launch the interactive terminal UI (mobile/SSH-friendly project + workspace picker)',
  longDesc:
    'An Ink-based picker over the same live status every other command reads: lists ' +
    'projects and workspaces (attention sorted first), and opens a workspace by hosting ' +
    'it in a tmux session and attaching (`tmux -L <socket> attach -t <session>`) so the ' +
    'session survives an SSH/Termius disconnect. Detaching from tmux returns to the picker ' +
    'rather than dropping to a shell. Requires an interactive terminal (TTY) and is not ' +
    'JSON-representable — --json is rejected. See docs/TUI_SPEC.md for the full keymap and ' +
    'layout contract.',
  maxPositionals: 0,
  flags: {
    project: {
      type: 'string',
      valueHint: '<id|name|path>',
      desc: 'Scope the picker to a single project (suppresses the project header row).',
      notes:
        'Resolved the same way as the global --project flag (id, then name, then ' +
        'filesystem path). Without this flag the picker shows every registered project — ' +
        'unlike most commands, there is no cwd/ORPHEUS_WORKSPACE_ID default scoping here. ' +
        'Useful for a Termius host entry with a per-project startup command ' +
        '(e.g. `orpheus tui --project api`), which pushes project selection into ' +
        "Termius's own host-group UI instead."
    }
  },
  examples: ['orpheus tui', 'orpheus tui --project api'],
  handler: async (ctx) => {
    if (ctx.jsonMode) {
      printUsageError('orpheus tui does not support --json (it is an interactive terminal UI)')
      return
    }

    const scopeResolution = resolveProjectScope(ctx.project)
    if (!scopeResolution.ok) {
      printNotFoundError(scopeResolution.message)
      return
    }

    // Lazy-load dist/tui.mjs — see the file header for why this is a dynamic
    // import() of an ESM bundle rather than a require() of another CJS one.
    const tuiEntryUrl = pathToFileURL(path.join(__dirname, 'tui.mjs')).href
    const tuiModule = (await import(tuiEntryUrl)) as TuiModule
    try {
      await tuiModule.runTui({ scope: scopeResolution.scope })
    } catch (err) {
      rethrowAcrossBundleBoundary(err)
    }
  }
})
