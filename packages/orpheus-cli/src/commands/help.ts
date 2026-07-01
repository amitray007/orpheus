/**
 * commands/help.ts — `orpheus help [command] [--format text|md|json]`.
 *
 * The agent-facing documentation command (Part 4 of the agent-first doc
 * system — see help-model.ts for the shared doc model this renders).
 *
 * USAGE
 * -----
 *   orpheus help                        full reference, --format text (default)
 *   orpheus help --format md            full reference as markdown (primary
 *                                        agent-ingestion format)
 *   orpheus help --format json          full reference as structured JSON
 *   orpheus help <command>              that command's rich help (same
 *                                        content as `orpheus <command> -h`)
 *
 * --format is validated against text|md|json; an invalid value is a usage
 * error (exit 2), same as any other bad flag value in this CLI.
 *
 * `orpheus help <command>` re-dispatches to the SAME rich per-command help
 * text produced for `<command> -h` in cli.ts — this module doesn't duplicate
 * that renderer, it imports and calls it, so the two entry points can never
 * drift from each other.
 *
 * This is a pure read (isRead: true) — it only introspects the in-memory
 * command registry, no disk/socket access, so it never triggers auto-launch.
 */

import { registerCommand, getCommand } from '../registry.js'
import { printError, printUsageError } from '../output.js'
import { buildDocModel, renderDocModelAsText, renderDocModelAsMarkdown } from '../help-model.js'
// commandHelp is cli.ts's rich single-command renderer (used by `<cmd> -h`).
// Importing it here (rather than reimplementing) guarantees `orpheus help
// <command>` and `orpheus <command> -h` can never show different content.
import { commandHelp } from '../cli.js'

const VALID_FORMATS = ['text', 'md', 'json'] as const
type Format = (typeof VALID_FORMATS)[number]

function isValidFormat(v: string): v is Format {
  return (VALID_FORMATS as readonly string[]).includes(v)
}

registerCommand('help', {
  isRead: true,
  usage: 'help [command...] [--format text|md|json]',
  help: 'Show the full CLI reference, or rich help for one command',
  longDesc:
    'With no command argument, prints the complete agent-facing CLI reference ' +
    '(every command, every flag, exit codes, env vars). With a command argument ' +
    "(e.g. 'orpheus help ws new'), prints that command's rich help — identical " +
    "to running 'orpheus ws new -h'. --format md is the primary format for an " +
    'agent to read once and learn the whole CLI as context.',
  // Variadic: 'orpheus help ws new' resolves to positionals ['ws', 'new'] since
  // 'ws new' isn't a registered command PATH by itself once 'help' consumed the
  // first token — so this command accepts any number of positionals and joins
  // them back into a command path itself (see handler).
  flags: {
    format: {
      type: 'string',
      desc: "Output format for the reference (or for a single command's help).",
      values: ['text', 'md', 'json'],
      valueHint: '<fmt>',
      default: 'text'
    }
  },
  examples: [
    'orpheus help',
    'orpheus help --format md',
    'orpheus help --format json',
    'orpheus help ws new',
    'orpheus help ws wait --format md'
  ],
  handler: async (ctx) => {
    const rawFormat = typeof ctx.flags.format === 'string' ? ctx.flags.format : 'text'
    if (!isValidFormat(rawFormat)) {
      printUsageError(
        `invalid --format value: "${rawFormat}". Use one of: ${VALID_FORMATS.join(', ')}.`
      )
      return
    }
    const format: Format = rawFormat

    // `orpheus help <command...>` — resolve the joined positionals against the
    // registry (longest-match, same convention as the main arg parser), and
    // print that command's rich help instead of the full reference.
    if (ctx.positionals.length > 0) {
      const joined = ctx.positionals.join(' ')
      let resolved: string | null = null
      for (let len = Math.min(ctx.positionals.length, 3); len >= 1; len--) {
        const candidate = ctx.positionals.slice(0, len).join(' ')
        if (getCommand(candidate) != null) {
          resolved = candidate
          break
        }
      }
      if (resolved == null) {
        printError(`unknown command: ${joined}. Run 'orpheus help' for the full command list.`, {
          exitCode: 3
        })
        return
      }
      const descriptor = getCommand(resolved)!
      if (format === 'json') {
        const model = buildDocModel()
        const cmd = model.commands.find((c) => c.name === resolved)
        process.stdout.write(JSON.stringify(cmd, null, 2) + '\n')
        return
      }
      // text and md both render as the same rich per-command text for a single
      // command — there's no separate markdown mode per-command; --format md's
      // value only diverges from text at the full-reference level.
      process.stdout.write(commandHelp(resolved, descriptor))
      return
    }

    const model = buildDocModel()
    if (format === 'json') {
      process.stdout.write(JSON.stringify(model, null, 2) + '\n')
    } else if (format === 'md') {
      process.stdout.write(renderDocModelAsMarkdown(model) + '\n')
    } else {
      process.stdout.write(renderDocModelAsText(model) + '\n')
    }
  }
})
