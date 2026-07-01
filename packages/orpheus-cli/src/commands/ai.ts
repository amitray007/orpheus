/**
 * commands/ai.ts — `orpheus ai <subcommand>` — the agent-facing interface layer.
 *
 * DESIGN: extensible subcommand group
 * ------------------------------------
 * `ai` is registered as a GROUP of full command paths ('ai skill', 'ai schema'),
 * the same convention as 'ws'/'project' elsewhere in this registry — there is
 * no special group-dispatch mechanism, longest-prefix matching in cli.ts's
 * parseArgv already does the routing. This file is intentionally the single
 * place new `ai <x>` subcommands get added later (e.g. a future `ai examples`
 * or `ai changelog`): follow the same registerCommand('ai <name>', ...) pattern
 * below and it's picked up automatically by `orpheus help`/`ai schema` via the
 * registry (no separate wiring needed).
 *
 * SUBCOMMANDS
 * -----------
 *   ai skill  [--format md|text, default md]
 *     A CURATED agent playbook — prose on HOW to use this CLI for fan-out
 *     orchestration, not just a flag dump. Meant to be read once by an agent
 *     as its "how do I drive Orpheus" context.
 *
 *   ai schema [--format json, default json]
 *     The machine-readable interface contract — structurally identical to
 *     `orpheus help --format json` (same buildDocModel() → JSON). Kept as a
 *     thin wrapper (not a re-derivation) so the two can never drift.
 *
 * DECISION: curated prose vs. generated facts (ai skill)
 * --------------------------------------------------------
 * `ai skill`'s narrative (the fan-out model, guardrails, when to use --fork vs
 * --task, etc.) is hand-written here — it encodes judgment calls ("default to
 * --background", "use --fork when...") that aren't mechanically derivable from
 * flag metadata. But every concrete FACT it states (flag names, values,
 * defaults, exit codes, env var names) is pulled from help-model.ts's
 * buildDocModel() at render time, so if a flag's default or accepted values
 * change, this doc can't silently go stale on those specifics — only the
 * hand-written judgment/strategy prose around them needs a human to keep
 * current (and that prose is deliberately small and stable: the orchestration
 * MODEL changes far less often than individual flag defaults do).
 *
 * READS
 * -----
 * Both subcommands are pure reads (isRead: true) — they only render docs from
 * the in-memory registry, no disk/socket access, so neither triggers
 * auto-launch of the app.
 */

import { registerCommand } from '../registry.js'
import { printUsageError } from '../output.js'
import { buildDocModel } from '../help-model.js'
import type { DocModel } from '../help-model.js'

const SKILL_FORMATS = ['md', 'text'] as const
type SkillFormat = (typeof SKILL_FORMATS)[number]
function isValidSkillFormat(v: string): v is SkillFormat {
  return (SKILL_FORMATS as readonly string[]).includes(v)
}

const SCHEMA_FORMATS = ['json'] as const
type SchemaFormat = (typeof SCHEMA_FORMATS)[number]
function isValidSchemaFormat(v: string): v is SchemaFormat {
  return (SCHEMA_FORMATS as readonly string[]).includes(v)
}

// ---------------------------------------------------------------------------
// ai skill — curated playbook
// ---------------------------------------------------------------------------

/** Look up a flag's rendered label (e.g. '--until <mode>') from the doc model, for inline prose use. */
function flagFacts(model: DocModel, commandName: string, flagName: string): string {
  const cmd = model.commands.find((c) => c.name === commandName)
  const flag = cmd?.flags.find((f) => f.name === flagName)
  if (flag == null) return `--${flagName}`
  return flag.type === 'boolean'
    ? `--${flag.name}`
    : `--${flag.name} ${flag.valueHint ?? '<value>'}`
}

/**
 * Look up a flag's label plus its accepted values/default, for standalone
 * bullet-point facts (not mid-sentence prose) — e.g. '--until <mode>
 * (done|input|idle) [default: done]'.
 */
function flagLine(model: DocModel, commandName: string, flagName: string): string {
  const cmd = model.commands.find((c) => c.name === commandName)
  const flag = cmd?.flags.find((f) => f.name === flagName)
  if (flag == null) return `--${flagName}`
  const label =
    flag.type === 'boolean' ? `--${flag.name}` : `--${flag.name} ${flag.valueHint ?? '<value>'}`
  const bits: string[] = [label]
  if (flag.values != null) bits.push(`(${flag.values.join('|')})`)
  if (flag.default != null) bits.push(`[default: ${flag.default}]`)
  return bits.join(' ')
}

function renderSkillMarkdown(model: DocModel): string {
  const exitCodeRows = model.exitCodes.map((ec) => `| ${ec.code} | ${ec.meaning} |`).join('\n')
  const envVarRows = model.envVars.map((ev) => `| \`${ev.name}\` | ${ev.desc} |`).join('\n')

  return `# Orpheus CLI — Agent Skill

You are an AI agent running inside an Orpheus workspace (a \`claude\` session
managed by the Orpheus app). The \`orpheus\` CLI is how you orchestrate OTHER
workspaces from inside this one — spawn worker agents, wait for them, collect
their results, and clean up. This document is the playbook: read it once and
you know how to drive the CLI. For exhaustive per-flag facts, run
\`orpheus help --format md\` or \`orpheus ai schema\`.

## What Orpheus is

Orpheus wraps the \`claude\` CLI in a project/workspace desktop UI. A **project**
is a registered working directory. A **workspace** is one isolated \`claude\`
session scoped to a project — creating a workspace always starts a real claude
session (there is no "headless" workspace; \`--empty\` just means no seed prompt
is typed into it). Workspaces can be nested: a workspace you spawn from inside
your own workspace becomes its child, forming a tree you can inspect with
\`orpheus ws ls --tree\`.

## The fan-out orchestration model

The core pattern this CLI exists for: **spawn workers, wait, read, clean up.**

1. **Spawn** a worker workspace with \`orpheus ws new\`:
   - \`${flagLine(model, 'ws new', 'task')}\` — seed it with a fresh task. The
     text is typed into the new workspace's claude prompt and submitted
     automatically (pass \`${flagFacts(model, 'ws new', 'no-submit')}\` to stage
     without pressing Enter, e.g. if you want to review/edit first).
   - \`${flagLine(model, 'ws new', 'fork')}\` — instead of a fresh task, have the
     worker inherit YOUR workspace's session history (via claude's
     \`--fork-session\`). Use this when the worker needs your context (files
     you've read, decisions made so far) rather than starting cold.
   - You almost always want exactly one of \`--task\` or \`--empty\`/\`--blank\` —
     \`ws new\` requires declaring intent explicitly (it's a usage error to pass
     neither, or both).
   - Project inheritance: you don't need \`--project\` when spawning from inside
     a workspace — the new workspace inherits your project automatically (via
     \`ORPHEUS_WORKSPACE_ID\`). Pass \`--project <id|name|path>\` to spawn into a
     DIFFERENT project.

2. **Wait** for the worker with \`orpheus ws wait <id>\`:
   - Default \`${flagLine(model, 'ws wait', 'until')}\` — waits until the worker
     stops running for ANY reason (finished, idle, or blocked on you). Use
     \`--until input\` to wait specifically until the worker needs YOUR input
     (skip past it merely going idle), or \`--until idle\` to wait until it's
     fully settled with nothing pending.
   - \`${flagLine(model, 'ws wait', 'timeout')}\` bounds how long you'll wait —
     accepts durations like \`10m\`, \`30s\`, \`1h\`.
   - You can wait on multiple ids at once: \`orpheus ws wait <id1> <id2> <id3>\`.

3. **Read** the result with \`orpheus ws read <id>\`:
   - Default (\`${flagLine(model, 'ws read', 'last-assistant')}\`) returns just
     the final assistant turn — the common "give me the answer" case.
   - \`${flagLine(model, 'ws read', 'full')}\` returns the entire transcript
     including tool calls, for when you need to audit HOW the worker got its
     answer, not just the answer.

4. **Clean up** with \`orpheus ws archive <id...>\` once you're done with a
   worker — archiving is idempotent-ish per id and accepts multiple ids in one
   call so you can batch-clean a whole fan-out. Pass \`--recursive\` to also
   archive a worker's own children.

## The exit-code contract (react to these, don't just check "did it fail")

\`orpheus ws wait\` is the command whose exit code you should branch on:

| Code | Meaning |
| --- | --- |
${exitCodeRows}

Concretely: after \`orpheus ws wait <id>\`, check \`$?\`:
- **0** → safe to \`orpheus ws read <id>\` for the result.
- **10** → the worker hit a permission prompt it can't resolve itself. You
  (the orchestrating agent) need to decide: either \`orpheus ws send <id> --key
  enter\`-style intervention if you know what it needs, or surface this to your
  own caller/user.
- **11** → the worker is blocked waiting on input — it asked a question. Read
  its last turn (\`orpheus ws read <id>\`) to see the question, then
  \`orpheus ws send <id> "<answer>" --submit\` to unblock it.
- **12** → timed out. The worker may still be running — it just didn't finish
  in your \`--timeout\` window. Decide whether to wait longer or treat it as
  failed.
- **13** → the worker died, or the Orpheus app itself isn't running. Don't
  retry blindly; something is actually broken.
- **3** → you passed a workspace id that doesn't exist. Check your id, not the
  worker's state.

Other commands share the base 0/1/2/3 codes (0 success, 1 general error, 2 bad
usage, 3 not found) — see \`orpheus help\` for the full table.

## Background vs. focus — don't disturb the user

Every command that can activate/mount a workspace (\`ws new\`, \`ws send\`, and
the auto-open inside them) defaults to **\`--background\`**: it does the work
without navigating the Orpheus GUI to that workspace. This is deliberate —
fan-out orchestration from an agent should never yank the user's screen around
to show them a worker they didn't ask to look at. Pass \`--focus\` explicitly
if you specifically want the GUI to jump to a workspace (e.g. you're spawning
something the user asked to watch). \`ws open\` is the one exception — it
defaults to \`--focus\` since "open this workspace" is inherently a navigation
request.

## Guardrails

The server enforces \`maxWorkspaceDepth\` and \`maxWorkspaceChildren\` from
global settings when you \`ws new\`. If your fan-out would exceed either cap,
\`ws new\` fails with a guiding error rather than silently creating an
unbounded tree — treat that failure as a signal to consolidate work into fewer
workers or archive finished ones before spawning more, not to retry blindly.

## Environment (usually nothing to do)

You're normally running inside a workspace terminal, where these are already
set for you:

| Variable | Description |
| --- | --- |
${envVarRows}

The practical upshot: you don't need \`--project\` for same-project fan-out,
and you don't need any auth/socket setup — it's already wired into your shell.

## Worked examples

**1. Fan out three independent workers, wait for all, collect results:**

\`\`\`sh
a=$(orpheus --json ws new --task "Summarize src/foo.ts" | jq -r .workspace.id)
b=$(orpheus --json ws new --task "Summarize src/bar.ts" | jq -r .workspace.id)
c=$(orpheus --json ws new --task "Summarize src/baz.ts" | jq -r .workspace.id)

orpheus ws wait "$a" "$b" "$c" --timeout 10m
echo "exit: $?"   # 0 if all three reached a terminal state in time

for id in "$a" "$b" "$c"; do
  echo "=== $id ==="
  orpheus ws read "$id" --last-assistant
done

orpheus ws archive "$a" "$b" "$c"
\`\`\`

**2. Spawn a worker that inherits your context, wait specifically for it to
need input:**

\`\`\`sh
id=$(orpheus --json ws new --fork --name "reviewer" | jq -r .workspace.id)
orpheus ws wait "$id" --until input --timeout 30m
case $? in
  0)  echo "reviewer finished without needing input" ;;
  11) orpheus ws read "$id" --last-assistant   # see what it's asking
      orpheus ws send "$id" "yes, proceed" --submit ;;
  12) echo "timed out — still working or stuck" ;;
esac
\`\`\`

**3. Steer a running workspace mid-task (no waiting):**

\`\`\`sh
orpheus ws send "$id" "actually, skip the tests for now" --submit
orpheus ws status "$id"          # quick activity check, no waiting
\`\`\`

**4. Check on a fan-out tree without blocking:**

\`\`\`sh
orpheus ws ls --tree             # see the whole workspace hierarchy
orpheus ws ls --status attention # find anything blocked on a decision
\`\`\`

**5. Create an empty worker to inspect manually before assigning work:**

\`\`\`sh
id=$(orpheus --json ws new --empty --name "scratch" | jq -r .workspace.id)
orpheus ws send "$id" "investigate the failing test in ./tests/foo.test.ts" --submit
\`\`\`

---
For the exhaustive per-command reference (every flag, every value, every
default), run \`orpheus help --format md\`. For the machine-readable schema
(same facts as JSON), run \`orpheus ai schema\`.
`
}

function renderSkillText(model: DocModel): string {
  // text mode: same content, markdown syntax stripped to plain readable text.
  // Kept intentionally simple (not a second hand-maintained document) — the
  // markdown IS the source, this just derives a plaintext rendering of it.
  const md = renderSkillMarkdown(model)
  return md
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\|.*\|$/gm, (line) =>
      line
        .split('|')
        .filter((cell) => cell.trim() !== '' && !/^-+$/.test(cell.trim()))
        .map((cell) => cell.trim())
        .join('  ')
    )
}

registerCommand('ai skill', {
  isRead: true,
  usage: 'ai skill [--format md|text]',
  help: 'Agent playbook: how to orchestrate workspaces via this CLI',
  longDesc:
    'A curated, narrative guide for an AI agent orchestrating Orpheus workspaces: ' +
    'the fan-out model (spawn/wait/read/archive), the ws-wait exit-code contract, ' +
    'background-vs-focus defaults, guardrails, and worked examples. Read this once ' +
    "to learn the CLI as a skill. For exhaustive flag-by-flag facts, use 'orpheus " +
    "help' or 'orpheus ai schema' instead.",
  flags: {
    format: {
      type: 'string',
      desc: 'Output format for the playbook.',
      values: ['md', 'text'],
      valueHint: '<fmt>',
      default: 'md'
    }
  },
  examples: ['orpheus ai skill', 'orpheus ai skill --format text'],
  handler: async (ctx) => {
    const raw = typeof ctx.flags.format === 'string' ? ctx.flags.format : 'md'
    if (!isValidSkillFormat(raw)) {
      printUsageError(`invalid --format value: "${raw}". Use one of: ${SKILL_FORMATS.join(', ')}.`)
      return
    }
    const model = buildDocModel()
    if (raw === 'text') {
      process.stdout.write(renderSkillText(model) + '\n')
    } else {
      process.stdout.write(renderSkillMarkdown(model) + '\n')
    }
  }
})

// ---------------------------------------------------------------------------
// ai schema — machine-readable interface contract
// ---------------------------------------------------------------------------

registerCommand('ai schema', {
  isRead: true,
  usage: 'ai schema [--format json]',
  help: 'Machine-readable CLI schema (same facts as `help --format json`)',
  longDesc:
    'Emits the structured doc model (commands, args, flags, exit codes, env vars) ' +
    'as JSON — the interface contract an agent (or another tool) can parse ' +
    'programmatically instead of screen-scraping help text. Identical in content ' +
    "to 'orpheus help --format json' — this is a thin, deliberately-undivergeable " +
    'alias under the `ai` group for discoverability.',
  flags: {
    format: {
      type: 'string',
      desc: 'Output format for the schema. Only json is supported.',
      values: ['json'],
      valueHint: '<fmt>',
      default: 'json'
    }
  },
  examples: ['orpheus ai schema', 'orpheus ai schema | jq .commands[0]'],
  handler: async (ctx) => {
    const raw = typeof ctx.flags.format === 'string' ? ctx.flags.format : 'json'
    if (!isValidSchemaFormat(raw)) {
      printUsageError(`invalid --format value: "${raw}". Use one of: ${SCHEMA_FORMATS.join(', ')}.`)
      return
    }
    const model = buildDocModel()
    process.stdout.write(JSON.stringify(model, null, 2) + '\n')
  }
})
