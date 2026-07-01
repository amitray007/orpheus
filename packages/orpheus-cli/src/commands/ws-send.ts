/**
 * commands/ws-send.ts — `ws send` command implementation.
 *
 * Injects text, a named key, and/or a submit (Enter) into a running interactive
 * workspace. If the workspace surface is not yet mounted, the server opens it
 * first (requestOpenWorkspace) and polls canInject for up to 10 s before
 * injecting. If the surface does not become injectable within that timeout, a
 * clear "not ready" error is returned.
 *
 * USAGE
 * -----
 *   ws send <id> [text] [--submit] [--key <name>]
 *
 *   ws send <id> "some prompt"              -- send text only
 *   ws send <id> "some prompt" --submit     -- send text then Return
 *   ws send <id> --key enter                -- send Return key
 *   ws send <id> "some text" --key escape   -- send text then Escape
 *
 * FLAGS
 * -----
 *   --submit            Send Return after text (or alone if no text)
 *   --key <name>        Send a named key after text (before submit if both present)
 *                       Recognised names: enter, return, escape, esc,
 *                       up, down, left, right, tab, backspace, delete, space
 *   --project <val>     Project context override (global flag: id, name, or path)
 *
 * ORDER OF OPERATIONS (when multiple modes are combined)
 * -------------------------------------------------------
 *   1. text is sent first (if provided)
 *   2. --key is sent next (if provided)
 *   3. --submit (Return) is sent last (if provided)
 *
 * This means `--submit` and `--key enter` behave slightly differently:
 *   --key enter  → sends a synthetic Enter keycode
 *   --submit     → calls terminalActions.submit() which also sends kVK_Return=0x24
 * In most cases they are equivalent; prefer --submit for submitting a prompt.
 *
 * NOT-READY BEHAVIOR
 * ------------------
 * If the workspace surface is busy (in_progress / attention) and does not
 * become injectable within the 10 s timeout, the server returns a structured
 * "not ready" error surfaced here with a clear message and exit code 1.
 *
 * AUTO-LAUNCH
 * -----------
 * Not isRead — AppNotRunningError triggers the standard auto-launch + retry
 * loop in cli.ts so `ws send` works even when the app is not yet running.
 */

import { registerCommand } from '../registry.js'
import { sendCommand } from '../socket-client.js'
import { printResult, printKeyValue, printError, printUsageError } from '../output.js'

registerCommand('ws send', {
  usage: 'ws send <id> [text] [--submit] [--key <name>]',
  help: 'Send text, a named key, and/or a submit (Enter) to a workspace',
  minPositionals: 1,
  // text is an OPTIONAL second positional (ws send <id> --key enter is valid
  // with zero text), so maxPositionals is 2, not 1 — do not tighten this to 1.
  maxPositionals: 2,
  flags: {
    submit: 'boolean',
    key: 'string'
    // --project is the global flag; cli.ts parses it as ctx.project
  },
  handler: async (ctx) => {
    const id = ctx.positionals[0]
    if (id == null || id === '') {
      printUsageError('usage: ws send <id> [text] [--submit] [--key <name>]')
      return
    }

    const text =
      typeof ctx.positionals[1] === 'string' && ctx.positionals[1] !== ''
        ? ctx.positionals[1]
        : undefined
    const submit = ctx.flags.submit === true
    const key =
      typeof ctx.flags.key === 'string' && ctx.flags.key !== '' ? ctx.flags.key : undefined

    if (text == null && key == null && !submit) {
      printUsageError('ws send: provide text, --key <name>, or --submit (at least one is required)')
      return
    }

    const args: Record<string, unknown> = { id }
    if (text != null) args.text = text
    if (submit) args.submit = true
    if (key != null) args.key = key

    let result: unknown
    try {
      result = await sendCommand('workspace.send', args)
    } catch (err) {
      printError(err)
      return
    }

    const data = result as { ok: boolean } | null

    printResult(data, () => {
      const summary: Record<string, unknown> = { id, sent: true }
      if (text != null) summary.text = text
      if (key != null) summary.key = key
      if (submit) summary.submit = true
      printKeyValue(summary)
    })
  }
})
