/**
 * command-help.ts — rich single-command help renderer, extracted from cli.ts.
 *
 * Lives here (rather than in cli.ts) so commands/help.ts can import the
 * renderer without importing cli.ts — cli.ts itself imports commands/* for
 * registration, so cli.ts -> commands/help.ts -> cli.ts was a circular import.
 */

import type { CommandDescriptor, FlagSpec } from './registry.js'
import { flagType, isFlagSpec } from './registry.js'
import { synthesizeUsage } from './help-model.js'

/**
 * Label used in the usage line / Flags heading for a single flag, e.g.
 * '--permission-mode <mode>' (rich, with a valueHint) or '--focus' (boolean).
 * Falls back to a generic '<value>' hint for string flags with no valueHint.
 */
function flagLabel(name: string, decl: 'boolean' | 'string' | FlagSpec): string {
  const kind = flagType(decl)
  if (kind === 'boolean') return `--${name}`
  const hint = (typeof decl !== 'string' ? decl.valueHint : undefined) ?? '<value>'
  return `--${name} ${hint}`
}

/**
 * Build RICH help text for a single command (Part 2 of the agent-first
 * documentation system). Uses the descriptor's explicit `usage`/`help`/
 * `longDesc` fields if provided; otherwise synthesizes a conventional usage
 * line from arity. Each flag renders with its full FlagSpec metadata (desc,
 * values, default, notes) each on their own indented line — legacy
 * 'boolean'|'string' flags still render (just with less detail, via
 * flagType()/flagLabel() which tolerate both shapes). Positional args
 * (argsSpec) and examples are rendered when present.
 */
export function commandHelp(commandPath: string, descriptor: CommandDescriptor): string {
  const lines: string[] = []
  lines.push(`orpheus ${commandPath}`)
  if (descriptor.help != null && descriptor.help !== '') {
    lines.push('')
    lines.push(descriptor.help)
  }
  if (descriptor.longDesc != null && descriptor.longDesc !== '') {
    lines.push('')
    lines.push(descriptor.longDesc)
  }
  lines.push('')
  lines.push('Usage:')
  if (descriptor.usage != null && descriptor.usage !== '') {
    lines.push(`  orpheus ${descriptor.usage}`)
  } else {
    lines.push(`  ${synthesizeUsage(commandPath, descriptor)}`)
  }

  if (descriptor.argsSpec != null && descriptor.argsSpec.length > 0) {
    lines.push('')
    lines.push('Arguments:')
    const labels = descriptor.argsSpec.map((a) => {
      const inner = a.variadic ? `${a.name}...` : a.name
      return a.required ? `<${inner}>` : `[${inner}]`
    })
    const width = Math.max(...labels.map((l) => l.length)) + 2
    descriptor.argsSpec.forEach((a, idx) => {
      lines.push(`  ${labels[idx]!.padEnd(width)}${a.desc}`)
      if (a.values != null && a.values.length > 0) {
        lines.push(`  ${''.padEnd(width)}values: ${a.values.join(' | ')}`)
      }
    })
  }

  lines.push('')
  lines.push('Global options:')
  lines.push('  --json              Emit JSON output')
  lines.push('  --project <val>     Set project context by id, name, or path')
  lines.push('  -h, --help          Show this help text')

  if (descriptor.flags != null && Object.keys(descriptor.flags).length > 0) {
    lines.push('')
    lines.push('Flags:')
    const entries = Object.entries(descriptor.flags)
    const labels = entries.map(([name, decl]) => flagLabel(name, decl))
    const width = Math.max(...labels.map((l) => l.length)) + 2
    entries.forEach(([, decl], idx) => {
      const label = labels[idx]!
      if (!isFlagSpec(decl)) {
        // Legacy shorthand — no rich metadata available, fall back to kind.
        lines.push(`  ${label.padEnd(width)}(${flagType(decl)})`)
        return
      }
      lines.push(`  ${label.padEnd(width)}${decl.desc}`)
      const pad = ''.padEnd(width)
      if (decl.values != null && decl.values.length > 0) {
        lines.push(`  ${pad}values: ${decl.values.join(' | ')}`)
      }
      if (decl.default != null && decl.default !== '') {
        lines.push(`  ${pad}default: ${decl.default}`)
      }
      if (decl.notes != null && decl.notes !== '') {
        lines.push(`  ${pad}note: ${decl.notes}`)
      }
    })
  }

  if (descriptor.examples != null && descriptor.examples.length > 0) {
    lines.push('')
    lines.push('Examples:')
    for (const ex of descriptor.examples) {
      lines.push(`  ${ex}`)
    }
  }

  lines.push('')
  return lines.join('\n') + '\n'
}
