/**
 * help-model.ts — shared agent-facing DOC MODEL for the Orpheus CLI.
 *
 * DECISION: single source of truth for documentation
 * -----------------------------------------------------
 * `orpheus help` (all three --format values) and `orpheus ai schema` must stay
 * in lockstep with each other and with the actual command registry — an agent
 * reading either one should get the same facts. Rather than hand-maintaining
 * two renderers that each walk getRegistry() independently (and drift), this
 * module builds ONE structured model (`buildDocModel()`) by introspecting:
 *   - the command registry (getRegistry()) + each CommandDescriptor's
 *     help/longDesc/usage/argsSpec/flags(FlagSpec)/examples/arity
 *   - the global flags (hand-declared here, since GLOBAL_FLAGS lives in cli.ts
 *     and isn't itself part of the registry)
 *   - the exit-code table (hand-declared here — it's a fixed contract, not
 *     derived from any command's metadata)
 *   - the env vars the CLI reads/honors (also a fixed contract)
 *
 * `commands/help.ts` renders this model as text/md/json. `commands/ai.ts`
 * reuses the exact same model for `ai schema` (so it's byte-for-byte the same
 * facts as `help --format json`) and pulls FACTS (flag lists, exit codes) from
 * it for `ai skill`'s curated prose, while the prose/narrative itself is
 * hand-written (see the DECISION note in commands/ai.ts for how that balance
 * is drawn).
 */

import { getRegistry, flagType, isFlagSpec } from './registry.js'
import type { CommandDescriptor, ArgSpec } from './registry.js'

// ---------------------------------------------------------------------------
// Model types
// ---------------------------------------------------------------------------

export type DocFlag = {
  name: string
  type: 'boolean' | 'string'
  valueHint?: string
  desc: string
  values?: string[]
  default?: string
  notes?: string
}

export type DocArg = {
  name: string
  required: boolean
  desc: string
  values?: string[]
  variadic?: boolean
}

export type DocCommand = {
  name: string
  description: string
  longDesc?: string
  usage: string
  isRead: boolean
  args: DocArg[]
  flags: DocFlag[]
  examples: string[]
}

export type DocGlobalFlag = {
  name: string
  type: 'boolean' | 'string'
  valueHint?: string
  desc: string
}

export type DocExitCode = {
  code: number
  meaning: string
}

export type DocEnvVar = {
  name: string
  desc: string
}

export type DocModel = {
  commands: DocCommand[]
  globalFlags: DocGlobalFlag[]
  exitCodes: DocExitCode[]
  envVars: DocEnvVar[]
}

// ---------------------------------------------------------------------------
// Fixed contracts — global flags, exit codes, env vars
// ---------------------------------------------------------------------------

/**
 * Global flags accepted before/around any command. Kept here (rather than
 * imported from cli.ts's GLOBAL_FLAGS) because cli.ts's GLOBAL_FLAGS is just
 * the parser-relevant 'boolean'|'string' shorthand — this is the richer,
 * agent-facing description of the same four flags.
 */
export const GLOBAL_FLAGS: DocGlobalFlag[] = [
  {
    name: 'json',
    type: 'boolean',
    desc: 'Emit stable, machine-readable JSON on stdout instead of human-readable text. Errors are also JSON in this mode: {"error": "...", "code": <exitCode>}.'
  },
  {
    name: 'project',
    type: 'string',
    valueHint: '<id|name|path>',
    desc: 'Set project context explicitly by project id, name, or filesystem path. Overrides the ORPHEUS_WORKSPACE_ID-derived project and cwd-prefix matching.'
  },
  {
    name: 'help',
    type: 'boolean',
    desc: "Show help. Bare 'orpheus -h' shows top-level usage; 'orpheus <command> -h' shows that command's rich help (same content as 'orpheus help <command>')."
  },
  {
    name: 'version',
    type: 'boolean',
    desc: 'Print the CLI version and exit 0.'
  }
]

/**
 * Exit-code contract. This is the table an agent needs to branch on — most
 * importantly `ws wait`'s 0/3/10/11/12/13 taxonomy (see ws-wait.ts's file
 * header for the full reasoning), but the table is stated once here as the
 * CLI-wide contract since a few codes (0/1/2/3) are shared by every command.
 */
export const EXIT_CODES: DocExitCode[] = [
  { code: 0, meaning: 'success (for `ws wait`: the workspace reached a terminal "done" state)' },
  { code: 1, meaning: 'general error (server/command error, unexpected failure)' },
  { code: 2, meaning: 'usage / argument error (bad flags, missing required args, invalid values)' },
  {
    code: 3,
    meaning:
      'not found (bad workspace/project id, or an explicit --project value that did not resolve)'
  },
  { code: 10, meaning: '`ws wait` only: blocked on a permission prompt (agent needs a decision)' },
  { code: 11, meaning: '`ws wait` only: blocked on user input (agent is waiting on the user)' },
  {
    code: 12,
    meaning: '`ws wait` only: timed out before reaching a terminal state (--timeout elapsed)'
  },
  {
    code: 13,
    meaning:
      '`ws wait` only: the session died (process/session file gone) or the Orpheus app was not running'
  }
]

/**
 * Env vars the CLI reads or that are relevant to understanding its behavior.
 * These are auto-injected into every workspace's shell by the Orpheus app —
 * an agent running inside a workspace terminal does not need to set them.
 */
export const ENV_VARS: DocEnvVar[] = [
  {
    name: 'ORPHEUS_WORKSPACE_ID',
    desc: 'Auto-injected into every workspace terminal by the app. Used to infer "current project" (via the owning workspace) when --project is not given, and to auto-attribute workspace.create\'s parentWorkspaceId for --fork/child bookkeeping. Set this manually only when scripting outside a workspace terminal.'
  },
  {
    name: 'ORPHEUS_CMD_TOKEN',
    desc: "Bearer token for the Unix-domain command socket. Auto-injected into every workspace terminal; the CLI otherwise reads it from the app's on-disk token file. Only set manually for out-of-workspace testing/scripting."
  },
  {
    name: 'ORPHEUS_CMD_SOCK',
    desc: 'Override path to the Unix-domain command socket (normally derived from the data dir). Auto-injected in workspace terminals; rarely needs manual setting.'
  },
  {
    name: 'ORPHEUS_DATA_VARIANT',
    desc: '"dev" or "prod" — selects which app data dir (and app name, for auto-launch) the CLI targets: "Orpheus Dev" vs "Orpheus". Defaults to the production variant if unset.'
  }
]

// ---------------------------------------------------------------------------
// Model builder
// ---------------------------------------------------------------------------

export function synthesizeUsage(commandPath: string, descriptor: CommandDescriptor): string {
  if (descriptor.usage != null && descriptor.usage !== '') {
    return `orpheus ${descriptor.usage}`
  }
  const min = descriptor.minPositionals ?? 0
  const max = descriptor.maxPositionals
  const positionalHint: string[] = []
  for (let idx = 0; idx < (max ?? min); idx++) {
    const label = `arg${idx + 1}`
    positionalHint.push(idx < min ? `<${label}>` : `[${label}]`)
  }
  if (max == null && min === 0 && positionalHint.length === 0) {
    positionalHint.push('[args...]')
  }
  const flagHint =
    descriptor.flags != null && Object.keys(descriptor.flags).length > 0 ? ' [flags]' : ''
  return `orpheus ${commandPath} ${positionalHint.join(' ')}${flagHint}`.trimEnd()
}

function toDocArgs(argsSpec: ArgSpec[] | undefined): DocArg[] {
  if (argsSpec == null) return []
  return argsSpec.map((a) => ({
    name: a.name,
    required: a.required,
    desc: a.desc,
    ...(a.values != null ? { values: a.values } : {}),
    ...(a.variadic === true ? { variadic: true } : {})
  }))
}

function toDocFlags(descriptor: CommandDescriptor): DocFlag[] {
  if (descriptor.flags == null) return []
  return Object.entries(descriptor.flags).map(([name, decl]) => {
    const type = flagType(decl)
    if (!isFlagSpec(decl)) {
      // Legacy shorthand — no rich metadata declared for this flag.
      return { name, type, desc: '' }
    }
    return {
      name,
      type,
      ...(decl.valueHint != null ? { valueHint: decl.valueHint } : {}),
      desc: decl.desc,
      ...(decl.values != null ? { values: decl.values } : {}),
      ...(decl.default != null ? { default: decl.default } : {}),
      ...(decl.notes != null ? { notes: decl.notes } : {})
    }
  })
}

/**
 * Build the full doc model by introspecting the command registry. Must be
 * called AFTER all command modules have registered (i.e. from within a
 * command handler at invocation time, not at module load time) — cli.ts
 * imports every command module before any handler runs, so by the time
 * `orpheus help`/`orpheus ai schema`'s handlers execute, getRegistry() is
 * complete.
 */
export function buildDocModel(): DocModel {
  const commands: DocCommand[] = []
  for (const [name, descriptor] of getRegistry()) {
    commands.push({
      name,
      description: descriptor.help ?? '',
      ...(descriptor.longDesc != null ? { longDesc: descriptor.longDesc } : {}),
      usage: synthesizeUsage(name, descriptor),
      isRead: descriptor.isRead === true,
      args: toDocArgs(descriptor.argsSpec),
      flags: toDocFlags(descriptor),
      examples: descriptor.examples ?? []
    })
  }
  // Stable, readable ordering: alphabetical by command path.
  commands.sort((a, b) => a.name.localeCompare(b.name))

  return {
    commands,
    globalFlags: GLOBAL_FLAGS,
    exitCodes: EXIT_CODES,
    envVars: ENV_VARS
  }
}

// ---------------------------------------------------------------------------
// Renderers — text and markdown. (JSON is just JSON.stringify(model) — no
// renderer needed; see commands/help.ts's --format json branch.)
// ---------------------------------------------------------------------------

/** Render a single flag's label, e.g. '--permission-mode <mode>' or '--focus'. */
function flagLabelOf(flag: DocFlag): string {
  if (flag.type === 'boolean') return `--${flag.name}`
  return `--${flag.name} ${flag.valueHint ?? '<value>'}`
}

/** Render a single arg's label, e.g. '<id>', '[text]', '<id...>'. */
function argLabelOf(arg: DocArg): string {
  const inner = arg.variadic === true ? `${arg.name}...` : arg.name
  return arg.required ? `<${inner}>` : `[${inner}]`
}

/** Push the "Global options:" section (text format) onto `lines`. */
function pushTextGlobalOptions(lines: string[], model: DocModel): void {
  lines.push('Global options:')
  for (const f of model.globalFlags) {
    const label = f.type === 'boolean' ? `--${f.name}` : `--${f.name} ${f.valueHint ?? '<value>'}`
    lines.push(`  ${label}`)
    lines.push(`    ${f.desc}`)
  }
}

/** Push one command's Arguments block (text format) onto `lines`. */
function pushTextCommandArgs(lines: string[], cmd: DocCommand): void {
  if (cmd.args.length === 0) return
  lines.push('  Arguments:')
  for (const a of cmd.args) {
    lines.push(`    ${argLabelOf(a).padEnd(14)}${a.desc}`)
    if (a.values != null) lines.push(`    ${''.padEnd(14)}values: ${a.values.join(' | ')}`)
  }
}

/** Push one command's Flags block (text format) onto `lines`. */
function pushTextCommandFlags(lines: string[], cmd: DocCommand): void {
  if (cmd.flags.length === 0) return
  lines.push('  Flags:')
  for (const f of cmd.flags) {
    lines.push(`    ${flagLabelOf(f)}`)
    if (f.desc !== '') lines.push(`      ${f.desc}`)
    if (f.values != null) lines.push(`      values: ${f.values.join(' | ')}`)
    if (f.default != null) lines.push(`      default: ${f.default}`)
    if (f.notes != null) lines.push(`      note: ${f.notes}`)
  }
}

/** Push one command's Examples block (text format) onto `lines`. */
function pushTextCommandExamples(lines: string[], cmd: DocCommand): void {
  if (cmd.examples.length === 0) return
  lines.push('  Examples:')
  for (const ex of cmd.examples) lines.push(`    ${ex}`)
}

/** Push a single command's full text-format block onto `lines`. */
function pushTextCommand(lines: string[], cmd: DocCommand): void {
  lines.push('')
  lines.push(`orpheus ${cmd.name}`)
  if (cmd.description !== '') lines.push(`  ${cmd.description}`)
  if (cmd.longDesc != null) lines.push(`  ${cmd.longDesc}`)
  lines.push(`  Usage: ${cmd.usage}`)
  lines.push(`  Read-only: ${cmd.isRead ? 'yes (never auto-launches the app)' : 'no'}`)

  pushTextCommandArgs(lines, cmd)
  pushTextCommandFlags(lines, cmd)
  pushTextCommandExamples(lines, cmd)
}

/** Push the "Exit codes" section (text format) onto `lines`. */
function pushTextExitCodes(lines: string[], model: DocModel): void {
  lines.push('')
  lines.push('='.repeat(78))
  lines.push('Exit codes')
  lines.push('='.repeat(78))
  for (const ec of model.exitCodes) {
    lines.push(`  ${String(ec.code).padEnd(4)}${ec.meaning}`)
  }
}

/** Push the "Environment variables" section (text format) onto `lines`. */
function pushTextEnvVars(lines: string[], model: DocModel): void {
  lines.push('')
  lines.push('='.repeat(78))
  lines.push('Environment variables')
  lines.push('='.repeat(78))
  for (const ev of model.envVars) {
    lines.push(`  ${ev.name}`)
    lines.push(`    ${ev.desc}`)
  }
}

/**
 * Render the full doc model as plain, readable text — the `--format text`
 * (default) output of `orpheus help`. Includes every command's full rich
 * help, plus the exit-code and env-var tables.
 */
export function renderDocModelAsText(model: DocModel): string {
  const lines: string[] = []
  lines.push('Orpheus CLI — full reference')
  lines.push('')
  lines.push('Command-line interface for the Orpheus app. Used mainly by AI agents inside')
  lines.push('Orpheus workspaces to orchestrate other workspaces (fan-out).')
  lines.push('')
  pushTextGlobalOptions(lines, model)

  lines.push('')
  lines.push('='.repeat(78))
  lines.push('Commands')
  lines.push('='.repeat(78))

  for (const cmd of model.commands) {
    pushTextCommand(lines, cmd)
  }

  pushTextExitCodes(lines, model)
  pushTextEnvVars(lines, model)
  lines.push('')

  return lines.join('\n')
}

/**
 * Escape a value for safe placement inside a markdown table cell: a literal
 * `|` (e.g. a valueHint like `<id|name|path>`, or an enum values list joined
 * with ` | `) would otherwise be parsed as a column separator and corrupt the
 * table. Backslashes are escaped first so a literal `\` in the input can't
 * collide with (or be mistaken for) the escaping we add for `|`. Newlines
 * are also flattened since a table cell must be single-line.
 */
function mdCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Push the "## Global options" section (markdown format) onto `lines`. */
function pushMdGlobalOptions(lines: string[], model: DocModel): void {
  lines.push('## Global options')
  lines.push('')
  lines.push('| Flag | Type | Description |')
  lines.push('| --- | --- | --- |')
  for (const f of model.globalFlags) {
    const label =
      f.type === 'boolean' ? `\`--${f.name}\`` : `\`--${f.name} ${f.valueHint ?? '<value>'}\``
    lines.push(`| ${mdCell(label)} | ${f.type} | ${mdCell(f.desc)} |`)
  }
  lines.push('')
}

/** Push one command's Arguments table (markdown format) onto `lines`. */
function pushMdCommandArgs(lines: string[], cmd: DocCommand): void {
  if (cmd.args.length === 0) return
  lines.push('**Arguments:**')
  lines.push('')
  lines.push('| Arg | Required | Description | Values |')
  lines.push('| --- | --- | --- | --- |')
  for (const a of cmd.args) {
    lines.push(
      `| \`${mdCell(argLabelOf(a))}\` | ${a.required ? 'yes' : 'no'} | ${mdCell(a.desc)} | ${a.values != null ? mdCell(a.values.join(', ')) : '—'} |`
    )
  }
  lines.push('')
}

/** Push one command's Flags table (markdown format) onto `lines`. */
function pushMdCommandFlags(lines: string[], cmd: DocCommand): void {
  if (cmd.flags.length === 0) return
  lines.push('**Flags:**')
  lines.push('')
  lines.push('| Flag | Description | Values | Default | Notes |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const f of cmd.flags) {
    lines.push(
      `| \`${mdCell(flagLabelOf(f))}\` | ${mdCell(f.desc || '—')} | ${f.values != null ? mdCell(f.values.join(', ')) : '—'} | ${f.default != null ? mdCell(f.default) : '—'} | ${f.notes != null ? mdCell(f.notes) : '—'} |`
    )
  }
  lines.push('')
}

/** Push one command's Examples block (markdown format) onto `lines`. */
function pushMdCommandExamples(lines: string[], cmd: DocCommand): void {
  if (cmd.examples.length === 0) return
  lines.push('**Examples:**')
  lines.push('')
  lines.push('```sh')
  for (const ex of cmd.examples) lines.push(ex)
  lines.push('```')
  lines.push('')
}

/** Push a single command's full markdown-format section onto `lines`. */
function pushMdCommand(lines: string[], cmd: DocCommand): void {
  lines.push(`### \`orpheus ${cmd.name}\``)
  lines.push('')
  if (cmd.description !== '') {
    lines.push(cmd.description)
    lines.push('')
  }
  if (cmd.longDesc != null) {
    lines.push(cmd.longDesc)
    lines.push('')
  }
  lines.push('```')
  lines.push(cmd.usage)
  lines.push('```')
  lines.push('')
  lines.push(
    `Read-only: ${cmd.isRead ? 'yes (never triggers auto-launch of the app)' : 'no (may auto-launch the app if it is not running)'}`
  )
  lines.push('')

  pushMdCommandArgs(lines, cmd)
  pushMdCommandFlags(lines, cmd)
  pushMdCommandExamples(lines, cmd)
}

/** Push the "## Exit codes" section (markdown format) onto `lines`. */
function pushMdExitCodes(lines: string[], model: DocModel): void {
  lines.push('## Exit codes')
  lines.push('')
  lines.push('| Code | Meaning |')
  lines.push('| --- | --- |')
  for (const ec of model.exitCodes) {
    lines.push(`| ${ec.code} | ${mdCell(ec.meaning)} |`)
  }
  lines.push('')
}

/** Push the "## Environment variables" section (markdown format) onto `lines`. */
function pushMdEnvVars(lines: string[], model: DocModel): void {
  lines.push('## Environment variables')
  lines.push('')
  lines.push('| Variable | Description |')
  lines.push('| --- | --- |')
  for (const ev of model.envVars) {
    lines.push(`| \`${ev.name}\` | ${mdCell(ev.desc)} |`)
  }
  lines.push('')
}

/**
 * Render the full doc model as MARKDOWN — the `--format md` output of
 * `orpheus help`, and the primary agent-ingestion format. Structured with
 * headings per command so an agent (or a human) can skim or grep it.
 */
export function renderDocModelAsMarkdown(model: DocModel): string {
  const lines: string[] = []
  lines.push('# Orpheus CLI Reference')
  lines.push('')
  lines.push(
    'Command-line interface for the Orpheus app — used mainly by AI agents inside ' +
      'Orpheus workspaces to orchestrate other workspaces (spawn workers, wait for ' +
      'them, read results, clean up). This document is a complete, machine-generated ' +
      'reference: every command, every flag, every accepted value and default.'
  )
  lines.push('')

  pushMdGlobalOptions(lines, model)

  lines.push('## Commands')
  lines.push('')

  for (const cmd of model.commands) {
    pushMdCommand(lines, cmd)
  }

  pushMdExitCodes(lines, model)
  pushMdEnvVars(lines, model)

  return lines.join('\n')
}
