// ---------------------------------------------------------------------------
// src/main/harness/codex/titleGeneration.ts
//
// support-multi-harness — best-effort sidebar-title generation for Codex
// workspaces. Codex sets the terminal title to the git repo folder name
// (verified empirically), so every Codex workspace in the same repo shows
// an identical, useless title — unlike Claude, which derives a real title
// from its own transcript (see resolveWorkspaceName's session-title rung).
// This module fills that gap by asking a LOCAL model to summarize the
// user's first prompt into a short title, then persisting it exactly once
// via workspaces.ts's existing setWorkspaceLastTitle.
//
// CAPABILITY-GATED, NEVER harnessId-GATED. Every entry point below reads
// CODEX_CAPABILITIES.titleGeneration (or, for the scheduler, is only ever
// called from a Codex-specific call site) rather than branching on
// `harnessId === 'codex-cli'` — see CLAUDE.md's capability-gating rule and
// src/shared/harness/types.ts's file header. CLAUDE_CAPABILITIES.
// titleGeneration is false, so scheduleCodexTitleGeneration is a no-op for
// every Claude workspace by construction, not by a harnessId check anyone
// could get wrong.
//
// WHY A DEDICATED "ALREADY ATTEMPTED" COLUMN, NOT "lastTitle IS NOT NULL".
// last_title can already be non-null for a Codex workspace from an
// UNRELATED source before this module ever runs:
//   1. the user manually renamed the workspace (renameWorkspace), or
//   2. index.ts's performClose captures the LIVE terminal title (the useless
//      repo-folder-name Codex sets) into last_title on every close, via
//      `getTitle(id) ?? null` — see index.ts's own comment: "Capture the
//      live terminal title BEFORE teardownWorkspaceResources clears it".
// So a freshly-closed-and-reopened Codex workspace can have a non-null
// last_title (the repo folder name) despite NEVER having been through this
// generator. Treating "lastTitle !== null" as "already generated" would
// permanently skip generation for that workspace, leaving the useless
// folder-name title in place forever. Conversely, a user who manually
// renamed a workspace has a non-null last_title this generator must NOT
// clobber on its next scheduled attempt — so "already generated" alone
// (ignoring lastTitle) isn't right either: a user's real title could get
// silently overwritten by a later `codex exec` fallback.
//
// The fix: gate PERSISTENCE on lastTitle already being set (never overwrite
// a title that exists for any reason — user rename or terminal capture,
// this module cannot tell them apart and shouldn't try), and gate WHETHER
// TO EVEN ATTEMPT on the dedicated `codex_title_generated` column (an
// attempt already made, successful or not, is never repeated). Both checks
// are required; neither alone is correct. See workspaces.ts's
// hasCodexTitleGenerationRun/markCodexTitleGenerationRun and schema.ts's
// column comment for the storage side of this.
//
// SINGLE-ATTEMPT-EVER, NOT BOUNDED RETRY. A failed attempt (both backends
// failed, or produced unusable output) still marks the workspace as
// attempted and never retries on a later mount. This was a deliberate
// choice over a small bounded-retry-count scheme: the task is inherently
// best-effort (a stale/useless terminal-title fallback remains available
// either way — this generator can only improve on it, never regress it),
// or a bounded retry would fire on every remount of a workspace whose first
// prompt genuinely never resolves to a usable title (e.g. the user's first
// message really is just noise), burning a local-model call every mount for
// no eventual gain. Single-attempt-ever is the simplest policy that matches
// "best-effort" and never surprises a user with a title that changes out
// from under them on a later mount.
//
// SCHEDULING SHAPE mirrors scheduleCodexSessionDiscovery (./session.ts) —
// same unref'd-timer, bounded-retry-delay discipline — but as a SEPARATE
// schedule, not piggybacked onto the session-discovery retries themselves.
// Session discovery only needs a BOUND session id (the rollout file exists
// with at least a session_meta line); title generation additionally needs
// that rollout to contain a REAL first user_message, which can lag behind
// binding by an unpredictable amount (however long the user takes to type
// their first prompt after the workspace opens). Reusing session
// discovery's short, fixed 1.5s/4s/10s cadence would either give up long
// before a slower-typing user's first prompt lands, or would need its
// delays lengthened in a way that would also affect session-binding
// latency for every Codex workspace, which is not this unit's concern to
// change. A separate, longer-tailed schedule keeps the two concerns
// independent.
//
// FAIL SOFT, ALWAYS. Every function here that touches the filesystem, spawns
// a child process, or reads the DB is wrapped so a failure degrades to
// "leave the existing title untouched, log at debug level only" rather than
// throwing into whatever timer invoked it. This must never block a mount,
// a status reconcile, or an IPC round trip.
// ---------------------------------------------------------------------------

import * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
import {
  getWorkspace,
  hasCodexTitleGenerationRun,
  markCodexTitleGenerationRun,
  setWorkspaceLastTitle
} from '../../workspaces'
import { CODEX_CAPABILITIES } from './curated'
import { getFirstUserPromptText } from './threadDb'

const execFile = promisify(childProcess.execFile)

// ---------------------------------------------------------------------------
// 1. First-prompt extraction
// ---------------------------------------------------------------------------
//
// support-multi-harness thread-DB migration — extraction is now a thin
// pass-through to threadDb.ts's getFirstUserPromptText(threadId), which
// reads Codex's OWN ~/.codex/thread_history_1.sqlite instead of re-parsing
// the rollout `.jsonl` transcript by hand.
//
// THE OLD DESIGN THIS REPLACES scanned rollout lines across two tiers
// (event_msg/user_message preferred, response_item/message/role=user
// fallback) and applied a "looks injected, not human-typed" heuristic — a
// candidate was skipped whenever its first line started with `#` or `<` —
// because injected context (AGENTS.md instructions, recommended_plugins,
// environment_context blocks, etc.) could land in the SAME text field as,
// or ahead of, the real human prompt within that raw event stream.
//
// THE THREAD DB DOES NOT HAVE THIS PROBLEM, VERIFIED DIRECTLY. Codex's own
// `thread_items` table already stores a clean, structured `userMessage`
// record — {type:'userMessage', content:[{type:'text', text}, ...]} — with
// no injected-context contamination mixed in: checked against 8/8 recent
// real threads on this machine, including prompts that themselves start
// with `#`, which the old heuristic would have WRONGLY skipped (its own
// documented, accepted failure mode — now eliminated rather than carried
// forward, since the data source no longer needs that discriminator at
// all). No blocklist, no `#`/`<` heuristic, no two-tier fallback — Codex
// already did the work of isolating the real human message; this module
// just reads it. See threadDb.ts's getFirstUserPromptText for the query
// (earliest turn with a non-null first_user_item_id, joined to its
// thread_items row) and its own header for the full verification detail.
//
// TORN/MISSING DATA TOLERATED — getFirstUserPromptText already degrades to
// null on every failure mode (DB missing, thread not found, malformed JSON,
// unexpected shape — see threadDb.ts's header), so readFirstPromptForWorkspace
// below needs no try/catch of its own around this call.

// ---------------------------------------------------------------------------
// 2. Output sanitization (PURE)
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- deliberately matches ANSI CSI/OSC escape sequences to strip them
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g

// A single layer of surrounding quotes — straight or smart/curly — stripped
// if the WHOLE sanitized string is wrapped in one matching pair. Only one
// layer: a model that double-quotes shouldn't have its inner content
// mangled by repeated stripping.
const SURROUNDING_QUOTES_RE = /^["'“‘](.*)["'”’]$/s

// Cap chosen to comfortably hold a 3-5 word title (the requested shape)
// with real margin for a slightly verbose model, while still reading as a
// short sidebar label rather than a second paragraph.
const MAX_TITLE_LENGTH = 60

// Above this length BEFORE truncation, treat the output as the model having
// ignored the "3-5 word title" instruction (e.g. echoed the whole prompt
// back, or produced a multi-sentence answer) rather than clean this up —
// truncating garbage still produces garbage, just shorter garbage.
const IMPLAUSIBLE_RAW_LENGTH = 300

/**
 * Sanitizes a raw model response into a short, single-line title, or null
 * if the input is empty/garbage after sanitization. Applied identically to
 * both backends' raw stdout.
 *
 * Steps: strip ANSI escapes -> reject if implausibly long pre-cap (garbage
 * heuristic, see IMPLAUSIBLE_RAW_LENGTH) -> reject if it looks like a code
 * fence or contains multiple blank-line-separated paragraphs (multi-
 * paragraph heuristic) -> collapse internal whitespace/newlines to single
 * spaces -> trim -> strip one layer of surrounding quotes -> trim again ->
 * reject if empty -> cap at MAX_TITLE_LENGTH, truncating at the last word
 * boundary within the cap when one exists so a cut doesn't land mid-word.
 */
export function sanitizeGeneratedTitle(raw: string): string | null {
  const withoutAnsi = raw.replace(ANSI_ESCAPE_RE, '')
  if (withoutAnsi.trim().length === 0) return null
  if (withoutAnsi.length > IMPLAUSIBLE_RAW_LENGTH) return null
  if (withoutAnsi.includes('```')) return null
  // Multi-paragraph heuristic: two or more consecutive newlines (a blank
  // line) suggests the model wrote prose/an explanation rather than a
  // single title line.
  if (/\n\s*\n/.test(withoutAnsi)) return null

  const collapsed = withoutAnsi.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null

  const quoteMatch = collapsed.match(SURROUNDING_QUOTES_RE)
  const unquoted = (quoteMatch ? quoteMatch[1] : collapsed).trim()
  if (!unquoted) return null

  if (unquoted.length <= MAX_TITLE_LENGTH) return unquoted

  // Truncate at the last word boundary within the cap when one exists,
  // rather than cutting mid-word.
  const truncated = unquoted.slice(0, MAX_TITLE_LENGTH)
  const lastSpace = truncated.lastIndexOf(' ')
  const clean = lastSpace > MAX_TITLE_LENGTH * 0.5 ? truncated.slice(0, lastSpace) : truncated
  return clean.trim()
}

// ---------------------------------------------------------------------------
// 3. fm-unavailable detection (PURE)
// ---------------------------------------------------------------------------

const FM_LEGAL_NOTICE_MARKER =
  'YOU HAVE NOT AGREED TO THE APPLE FOUNDATION MODELS CLI LEGAL NOTICE & TERMS'

/**
 * Decides whether an `fm respond` invocation should be treated as
 * UNAVAILABLE (fall through to the codex-exec backend) rather than a
 * successful call whose stderr merely carries a benign warning.
 *
 * TRIGGERS "unavailable": the binary is missing (errored — pass a truthy
 * `errored`), OR either stdout or stderr contains the exact legal-notice
 * marker string.
 *
 * DOES NOT TRIGGER "unavailable": ordinary successful stdout, or stderr
 * containing an UNRELATED message such as the "Private Cloud Compute is not
 * available in this context" warning `fm respond` can print on stderr while
 * still succeeding on stdout with exit 0 — that case must be treated as
 * SUCCESS per this feature's verified behavior, never as unavailable. This
 * predicate intentionally does not special-case that string at all: it
 * simply isn't the legal-notice marker, so the substring check already
 * leaves it alone.
 *
 * Never gates on `fm available` (a separate subcommand) — verified that it
 * can exit 1 even when the system model works fine, which would disable fm
 * permanently for no reason. This predicate judges only the ACTUAL
 * `fm respond` call's own output/error.
 */
export function isFmUnavailable(stdout: string, stderr: string, errored: boolean): boolean {
  if (errored) return true
  return stdout.includes(FM_LEGAL_NOTICE_MARKER) || stderr.includes(FM_LEGAL_NOTICE_MARKER)
}

// ---------------------------------------------------------------------------
// 4. Prompt template + backends (IMPURE — spawns child processes)
// ---------------------------------------------------------------------------

// Truncated so the OUTER prompt (the template below) stays bounded even for
// an extremely long first message.
const MAX_EMBEDDED_PROMPT_LENGTH = 500

// IDENTICAL template for both backends, per the task brief, so results are
// comparable regardless of which backend actually answered.
function buildTitlePrompt(firstPrompt: string): string {
  const truncated =
    firstPrompt.length > MAX_EMBEDDED_PROMPT_LENGTH
      ? firstPrompt.slice(0, MAX_EMBEDDED_PROMPT_LENGTH)
      : firstPrompt
  return `Reply with ONLY a 3-5 word title, no quotes, no punctuation, for: "${truncated}"`
}

// Hard per-backend timeout. execFile's own `timeout` option kills the child
// (default SIGTERM) once exceeded — no manual setTimeout/child.kill needed,
// same pattern github.ts/claudeUsage.ts already use for every execFile call
// in this codebase.
const BACKEND_TIMEOUT_MS = 15_000

/**
 * Backend 1 (preferred) — Apple Foundation Models CLI. Invoked as an argv
 * array (never a shell string — the prompt is untrusted user text). Returns
 * the sanitized title, or null if fm is unavailable/failed/produced
 * unusable output — the caller falls through to backend 2 on null.
 *
 * STDERR IS IGNORED FOR SUCCESS/FAILURE — judged purely by exit code 0 plus
 * non-empty stdout after sanitization (see isFmUnavailable's own doc
 * comment for why stderr content alone must never veto a successful call).
 */
async function tryFmBackend(prompt: string): Promise<string | null> {
  let stdout = ''
  let stderr = ''
  let errored = false
  try {
    const result = await execFile('fm', ['respond', prompt], {
      timeout: BACKEND_TIMEOUT_MS,
      killSignal: 'SIGTERM'
    })
    stdout = result.stdout
    stderr = result.stderr
  } catch (err) {
    errored = true
    // execFile's rejection error carries partial stdout/stderr when the
    // child produced output before failing/timing out (e.g. non-zero exit
    // after printing the legal notice) — recover them defensively so
    // isFmUnavailable can still see the marker string even on a rejected
    // call.
    const partial = err as { stdout?: string; stderr?: string }
    stdout = partial.stdout ?? ''
    stderr = partial.stderr ?? ''
    console.debug(
      '[codexTitleGeneration] fm backend invocation failed (exit/spawn error), falling back to codex exec'
    )
  }

  if (isFmUnavailable(stdout, stderr, errored)) {
    console.debug('[codexTitleGeneration] fm backend unavailable, falling back to codex exec')
    return null
  }

  const sanitized = sanitizeGeneratedTitle(stdout)
  if (!sanitized) {
    console.debug('[codexTitleGeneration] fm backend produced unusable output, rejecting')
    return null
  }
  return sanitized
}

/**
 * Backend 2 (fallback) — `codex exec --ephemeral`. Every flag below is
 * load-bearing and already verified against a live run; do not change any
 * of them without re-verifying (see this module's header for --ephemeral's
 * role and this file's task-brief provenance):
 *   --skip-git-repo-check   valid on `codex exec` specifically (an exec-only
 *                           flag — see curated.ts's own comment on why it's
 *                           absent from the interactive-binary default args)
 *   --ephemeral             writes NO rollout file and NO thread-writer
 *                           lock — essential so this call leaves no trace
 *                           for session discovery/status reconciliation to
 *                           confuse with a real session
 *   --ignore-user-config    skips the user's AGENTS.md/skills/hooks/MCP
 *                           servers — keeps this a cheap, isolated call
 *   model=gpt-5.3-codex-spark   the cheapest working model; gpt-5.6-spark is
 *                           REJECTED on ChatGPT accounts, do not substitute
 *
 * Output: the LAST non-empty stdout line (exec prints its own boilerplate
 * before the answer). Returns the sanitized title, or null on any failure
 * (timeout, non-zero exit, empty output, unusable output after
 * sanitization).
 */
async function tryCodexExecBackend(prompt: string): Promise<string | null> {
  let stdout: string
  try {
    const result = await execFile(
      'codex',
      [
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-user-config',
        '-c',
        'model=gpt-5.3-codex-spark',
        '-c',
        'model_reasoning_effort=low',
        '-c',
        'base_instructions=You are a concise title generator. Reply with only the title.',
        prompt
      ],
      { timeout: BACKEND_TIMEOUT_MS, killSignal: 'SIGTERM' }
    )
    stdout = result.stdout
  } catch {
    console.debug('[codexTitleGeneration] codex exec backend failed (exit/spawn error/timeout)')
    return null
  }

  const lastLine = [...stdout.split('\n')].reverse().find((line) => line.trim().length > 0)
  if (!lastLine) {
    console.debug('[codexTitleGeneration] codex exec backend produced no output')
    return null
  }

  const sanitized = sanitizeGeneratedTitle(lastLine)
  if (!sanitized) {
    console.debug('[codexTitleGeneration] codex exec backend produced unusable output, rejecting')
    return null
  }
  return sanitized
}

/**
 * Runs backend 1 (fm) then, only if it returns null, backend 2
 * (codex exec). Returns the first usable sanitized title, or null if both
 * backends failed/produced nothing usable. This is the ONE function that
 * decides fallback — every other function above is a pure predicate or a
 * single-backend invoker with no knowledge of the other backend.
 */
async function generateTitleForPrompt(firstPrompt: string): Promise<string | null> {
  const prompt = buildTitlePrompt(firstPrompt)
  const fmTitle = await tryFmBackend(prompt)
  if (fmTitle) return fmTitle
  return tryCodexExecBackend(prompt)
}

// ---------------------------------------------------------------------------
// 5. Scheduling/orchestration (IMPURE — fs, DB, child processes, timers)
// ---------------------------------------------------------------------------

/**
 * One attempt: reads the workspace's bound rollout file (if any), extracts
 * the first real user prompt, generates a title, and persists it via
 * setWorkspaceLastTitle — but ONLY if lastTitle is still unset (never
 * overwrite a title from any other source; see this module's header on why
 * that check is separate from the "already attempted" gate). Marks the
 * workspace as attempted in EVERY case that reaches a generation decision
 * (no rollout yet is NOT such a case — see runOneAttempt's caller, which
 * only calls this once a prompt has actually been found), so a single
 * success or a single failure both permanently retire this workspace from
 * future attempts.
 *
 * Never throws — every failure path logs at debug level (never info/warn/
 * error, and never the prompt/title text itself — see this module's header)
 * and returns without persisting.
 */
async function runOneAttempt(workspaceId: string, firstPrompt: string): Promise<void> {
  try {
    const title = await generateTitleForPrompt(firstPrompt)
    // Re-check lastTitle right before writing, not just at schedule time —
    // a user could have renamed the workspace (or performClose could have
    // captured a terminal title) during the several seconds this generation
    // call was in flight.
    const ws = getWorkspace(workspaceId)
    if (ws && !ws.lastTitle && title) {
      setWorkspaceLastTitle(workspaceId, title)
    }
  } catch (err) {
    // Defensive catch-all — every function above already fails soft on its
    // own, but a DB read/write hiccup (getWorkspace/setWorkspaceLastTitle)
    // could still throw. Never let it escape to the caller's timer.
    console.debug('[codexTitleGeneration] generation attempt threw:', String(err))
  } finally {
    // Mark attempted regardless of outcome — single-attempt-ever policy,
    // see this module's header. A best-effort mark: if this itself throws
    // (DB hiccup), the workspace may be retried once more on a later
    // schedule, which is an acceptable, still-bounded degradation (never an
    // infinite retry — the retry schedule itself is finite, see below).
    try {
      markCodexTitleGenerationRun(workspaceId)
    } catch (err) {
      console.debug('[codexTitleGeneration] failed to mark generation attempted:', String(err))
    }
  }
}

/**
 * Reads the workspace's bound thread's first user prompt from Codex's own
 * thread_history_1.sqlite (threadDb.ts's getFirstUserPromptText — see this
 * module's header, section 1) — or null if there is no binding yet, no
 * thread DB, or no user message recorded yet for this thread. Never throws
 * — getFirstUserPromptText already fails soft on every error (see its own
 * doc comment in threadDb.ts).
 */
function readFirstPromptForWorkspace(claudeSessionId: string): string | null {
  return getFirstUserPromptText(claudeSessionId)
}

// Retry cadence for "does a first prompt exist yet". Longer-tailed than
// session discovery's (see this module's header for why it's a separate
// schedule): a user may take a while to type their first message after a
// workspace opens, and this schedule only needs to eventually notice a
// prompt landing, not race a fast-appearing file the way session discovery
// does. Bounded, not indefinite — matches this module's fail-soft/
// best-effort framing: a workspace whose first prompt never lands within
// this window (or is entered but never resolves to any real prompt) simply
// keeps the useless terminal-title fallback forever, which is a pre-
// existing, non-regressive outcome, not a new failure this module owns.
const TITLE_RETRY_DELAYS_MS = [3000, 8000, 15000, 30000, 60000]

/**
 * Fire-and-forget: schedules attempts at increasing delays after a Codex
 * launch, stopping early once (a) the workspace already has a title, (b) a
 * generation attempt has already run for this workspace (ever, across any
 * prior mount — see the dedicated codex_title_generated column), or (c) a
 * first prompt is found and an attempt is kicked off (which itself marks
 * the workspace attempted on completion, so later scheduled delays for the
 * SAME launch no-op via the same early-return once they fire).
 *
 * CAPABILITY-GATED at the top — CODEX_CAPABILITIES.titleGeneration must be
 * true, so this is a complete no-op unless called for a harness that
 * actually declares the capability (Claude's descriptor sets it false,
 * making this whole module inert for Claude workspaces regardless of call
 * site — see this module's header).
 *
 * Uses unref'd timers, mirroring scheduleCodexSessionDiscovery — a pending
 * attempt must never keep the main process alive on its own.
 */
export function scheduleCodexTitleGeneration(workspaceId: string): void {
  if (!CODEX_CAPABILITIES.titleGeneration) return

  for (const delayMs of TITLE_RETRY_DELAYS_MS) {
    const timer = setTimeout(() => {
      void (async () => {
        let ws: ReturnType<typeof getWorkspace>
        try {
          ws = getWorkspace(workspaceId)
        } catch {
          return
        }
        if (!ws) return
        if (ws.lastTitle) return
        let alreadyRun: boolean
        try {
          alreadyRun = hasCodexTitleGenerationRun(workspaceId)
        } catch {
          return
        }
        if (alreadyRun) return
        if (!ws.claudeSessionId) return

        const firstPrompt = readFirstPromptForWorkspace(ws.claudeSessionId)
        if (!firstPrompt) return

        await runOneAttempt(workspaceId, firstPrompt)
      })()
    }, delayMs)
    timer.unref?.()
  }
}
