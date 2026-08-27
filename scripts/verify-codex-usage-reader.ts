// ---------------------------------------------------------------------------
// scripts/verify-codex-usage-reader.ts
//
// Behavior guard for src/main/harness/codex/usage.ts (footer-removal
// migration Phase 1, support-multi-harness) — Codex's session.getUsage/
// session.getCost reader, the harness-neutral seam's Codex-side
// implementation (see src/main/actions/sessionUsageReader.ts for the
// dispatch this plugs into).
//
// FIXTURES ARE REAL-SHAPED, NOT INVENTED: every field/value below is drawn
// directly from an ACTUAL rollout file inspected on a dev machine during
// this unit's build (557 real files under ~/.codex/sessions at the time) —
// the exact token_count/turn_context record shapes, field names, and a
// representative set of real numbers (input_tokens, cached_input_tokens,
// cache_write_input_tokens, output_tokens, reasoning_output_tokens,
// total_tokens, model_context_window). This is deliberately NOT the
// thinner shape the ORIGINATING task brief described (which only mentioned
// a combined total_tokens) — that brief undersold what the rollout actually
// carries, and testing against the richer real shape is what the codebase's
// "verify against the real thing" discipline calls for.
//
// FUNCTIONALLY DB-FREE, BUT THE IMPORT CHAIN STILL TOUCHES ELECTRON:
// getCodexUsage/getCodexCost take a bare claudeSessionId (not a
// WorkspaceRecord) and never call getWorkspace at runtime — but
// src/main/harness/codex/session.ts (which usage.ts imports for
// findCodexRolloutFileById/codexSessionsRoot) itself imports
// ../../workspaces for its OTHER exports (discoverAndBindCodexSession,
// codexSessionArgs), and workspaces.ts imports `electron` at module scope
// for getDb(). That import happens whether or not this script ever CALLS
// getWorkspace, so `bun run` alone fails to even resolve the module graph
// (`electron/index.js` has no named export 'app' in Bun's resolution — see
// verify-harness-codex-session.ts's own header for the same root cause).
// Same node:module register() resolve-hook technique as that file (and
// verify-harness-session.ts/verify-harness-codex-launch.ts), stubbing ONLY
// `electron` — no node:sqlite DB stub needed here since nothing in this
// script's call path ever reaches getDb()/getWorkspace.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const electronStubSource = `
export const app = {}
export const BrowserWindow = { getAllWindows: () => [] }
`

// src/main/db is a DIRECTORY module (db/index.ts) — node's ESM resolver
// rejects a bare directory import outright (ERR_UNSUPPORTED_DIR_IMPORT)
// rather than falling back to index.ts the way bundler resolution does.
// workspaces.ts (imported transitively via codex/session.ts, for its OTHER
// exports this script never calls — see this file's header) imports './db'
// at module scope for getDb(); real db/index.ts also imports
// better-sqlite3, a native addon that doesn't load outside Electron. This
// script's call path never actually invokes getDb(), so the stub only
// needs to exist, never be exercised — same technique as
// verify-harness-codex-session.ts/verify-harness-session.ts (both hit the
// identical './db' specifier from the identical workspaces.ts import).
const dbStubSource = `
export function getDb() {
  throw new Error('verify-codex-usage-reader: getDb() should never be called on this script\\'s call path')
}
`

const hooks = `
const electronStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(electronStubSource))}
const dbStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(dbStubSource))}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: electronStubUrl, shortCircuit: true }
  }
  if (specifier === './db' || specifier === '../db' || specifier === '../../db') {
    return { url: dbStubUrl, shortCircuit: true }
  }
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return await nextResolve(specifier + '.ts', context)
    }
    throw err
  }
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), import.meta.url)

const { parseCodexUsageFromRolloutFile, getCodexUsage, getCodexCost } =
  await import('../src/main/harness/codex/usage.ts')
const { findCodexRolloutFileById } = await import('../src/main/harness/codex/session.ts')
const { refreshModelsDevCache } = await import('../src/main/models/registry.ts')

// getCodexCost's pricing resolution goes through resolveModel ->
// modelsDevSource, whose in-memory cache starts EMPTY until something calls
// refreshModelsDevCache() (normally done once at app boot — see
// src/main/index.ts). This script runs standalone, so it must trigger that
// fetch itself before asserting on real Codex model pricing — a live
// network call, matching the task brief's own directive to verify this
// empirically rather than assume it. If the network is unavailable, the
// GENERAL reader behavior (parsing, null-degrade, unknown-pricing-degrade)
// is still fully exercised below; only the "gpt-5.4 resolves to REAL
// pricing" assertion in section 6 is skipped, with a clear console note —
// never silently passed as if verified.
let modelsDevAvailable = true
try {
  await refreshModelsDevCache()
} catch (err) {
  modelsDevAvailable = false
  console.warn(
    '[verify-codex-usage-reader] models.dev fetch failed — skipping the real-pricing assertion in section 6:',
    err
  )
}

// ---------------------------------------------------------------------------
// Fixture builder — one rollout file with a session_meta line, a
// turn_context line (carrying the model), and one or more token_count
// lines. Field values are drawn from a REAL rollout inspected on a dev
// machine (see this file's header).
// ---------------------------------------------------------------------------

const SESSION_ID = '01a00374-d82b-76e3-a5ba-1738be4d47a5'

function realTokenCountLine(overrides: {
  totalTokens: number
  lastTotalTokens: number
  contextWindow: number | null
}): string {
  return JSON.stringify({
    timestamp: '2026-08-15T03:29:06.177Z',
    ordinal: 115,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 643674,
          cached_input_tokens: 556800,
          cache_write_input_tokens: 0,
          output_tokens: 5155,
          reasoning_output_tokens: 2216,
          total_tokens: overrides.totalTokens
        },
        last_token_usage: {
          input_tokens: 64491,
          cached_input_tokens: 63232,
          cache_write_input_tokens: 0,
          output_tokens: 1415,
          reasoning_output_tokens: 970,
          total_tokens: overrides.lastTotalTokens
        },
        ...(overrides.contextWindow !== null
          ? { model_context_window: overrides.contextWindow }
          : {})
      },
      rate_limits: {
        limit_id: 'codex',
        limit_name: null,
        primary: { used_percent: 6.0, window_minutes: 10080, resets_at: 1787214645 },
        secondary: null,
        credits: { has_credits: false, unlimited: false, balance: '0' },
        individual_limit: null,
        spend_control_reached: null,
        plan_type: 'pro',
        rate_limit_reached_type: null
      }
    }
  })
}

function realTurnContextLine(model: string): string {
  return JSON.stringify({
    timestamp: '2026-08-15T03:27:11.682Z',
    ordinal: 7,
    type: 'turn_context',
    payload: {
      turn_id: '01a00375-8ebf-7441-b4ce-1a0e34c95968',
      cwd: '/Users/maverick/code/projects',
      model,
      approval_policy: 'never'
    }
  })
}

function sessionMetaLine(id: string): string {
  return JSON.stringify({
    timestamp: '2026-08-15T03:26:24.304Z',
    type: 'session_meta',
    payload: {
      session_id: id,
      id,
      cwd: '/Users/maverick/code/projects',
      thread_source: 'user'
    }
  })
}

/** Writes a rollout file for `id` under a FRESH temp $CODEX_HOME (dedicated
 *  per call, never a shared system dir like os.tmpdir() itself), at today's
 *  shard day, with the given lines. Returns BOTH the codexHome (for setting
 *  process.env.CODEX_HOME, and for later rm'ing ONLY this fixture's own
 *  tree) and the sessionsRoot (codexHome/sessions, the root
 *  findCodexRolloutFileById itself expects) — mirroring
 *  findCodexRolloutFileById's own expected directory shape
 *  (<sessionsRoot>/<YYYY>/<MM>/<DD>/rollout-*.jsonl). Keeping codexHome
 *  dedicated (not `path.dirname(sessionsRoot)`, which previously resolved
 *  to the shared os.tmpdir() itself and caused the fixture cleanup to try
 *  deleting all of /tmp) is what makes cleanup safe to do unconditionally. */
function writeRolloutFixture(
  id: string,
  lines: string[]
): { codexHome: string; sessionsRoot: string } {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-verify-'))
  const sessionsRoot = path.join(codexHome, 'sessions')
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const shardDir = path.join(sessionsRoot, yyyy, mm, dd)
  fs.mkdirSync(shardDir, { recursive: true })
  const filePath = path.join(shardDir, `rollout-2026-08-15T08-56-24-${id}.jsonl`)
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8')
  return { codexHome, sessionsRoot }
}

// ---------------------------------------------------------------------------
// 1. parseCodexUsageFromRolloutFile — exact numbers come back from a
//    realistically-shaped rollout file.
// ---------------------------------------------------------------------------
{
  const lines = [
    sessionMetaLine(SESSION_ID),
    realTurnContextLine('gpt-5.6-sol'),
    realTokenCountLine({ totalTokens: 648829, lastTotalTokens: 65906, contextWindow: 258400 })
  ]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-parse-'))
  const filePath = path.join(dir, 'rollout-test.jsonl')
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8')

  const parsed = parseCodexUsageFromRolloutFile(filePath)
  assert.ok(parsed, 'a rollout with a real token_count line must parse, not return null')
  assert.equal(parsed!.total.input_tokens, 643674, 'cumulative input_tokens must match the fixture')
  assert.equal(parsed!.total.total_tokens, 648829, 'cumulative total_tokens must match the fixture')
  assert.equal(
    parsed!.lastTurn.total_tokens,
    65906,
    'last-turn total_tokens must come from last_token_usage, not the cumulative bucket'
  )
  assert.equal(parsed!.contextWindow, 258400, 'model_context_window must be read verbatim')
  assert.equal(
    parsed!.model,
    'gpt-5.6-sol',
    "model must be read from the LAST turn_context line's payload.model"
  )

  fs.rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 2. A rollout with NO token_count line at all -> null, never a fabricated
//    zeroed shape or a thrown error.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-empty-'))
  const filePath = path.join(dir, 'rollout-empty.jsonl')
  fs.writeFileSync(
    filePath,
    [sessionMetaLine(SESSION_ID), realTurnContextLine('gpt-5.4')].join('\n') + '\n',
    'utf8'
  )

  const parsed = parseCodexUsageFromRolloutFile(filePath)
  assert.equal(
    parsed,
    null,
    'a rollout with no token_count line must return null, not a fabricated zeroed shape'
  )

  fs.rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 3. A missing file -> null, never throws.
// ---------------------------------------------------------------------------
{
  const parsed = parseCodexUsageFromRolloutFile('/nonexistent/path/rollout.jsonl')
  assert.equal(parsed, null, 'a missing rollout file must degrade to null, never throw')
}

// ---------------------------------------------------------------------------
// 4. findCodexRolloutFileById — sanity that the id->path lookup this
//    reader depends on actually resolves a real fixture (guards against the
//    reader silently depending on a lookup that's broken independently of
//    the parsing logic above).
// ---------------------------------------------------------------------------
{
  const lines = [
    sessionMetaLine(SESSION_ID),
    realTurnContextLine('gpt-5.4'),
    realTokenCountLine({ totalTokens: 1000, lastTotalTokens: 500, contextWindow: 128000 })
  ]
  const { codexHome, sessionsRoot } = writeRolloutFixture(SESSION_ID, lines)
  const found = findCodexRolloutFileById(sessionsRoot, SESSION_ID)
  assert.ok(
    found,
    'findCodexRolloutFileById must locate the fixture rollout by its session_meta.payload.id'
  )
  assert.ok(found!.includes(SESSION_ID), 'the resolved path must be the fixture file itself')

  const notFound = findCodexRolloutFileById(sessionsRoot, 'some-other-id-that-does-not-exist')
  assert.equal(
    notFound,
    null,
    'an unknown id must resolve to null, never throw or return a wrong file'
  )

  fs.rmSync(codexHome, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 5. getCodexUsage end-to-end — exact SessionUsage numbers, via
//    CODEX_HOME override so getCodexUsage's internal codexSessionsRoot()
//    resolves to our fixture root without touching the real ~/.codex.
// ---------------------------------------------------------------------------
{
  const lines = [
    sessionMetaLine(SESSION_ID),
    realTurnContextLine('gpt-5.6-sol'),
    realTokenCountLine({ totalTokens: 648829, lastTotalTokens: 65906, contextWindow: 258400 })
  ]
  // codexSessionsRoot() (session.ts) resolves $CODEX_HOME/sessions —
  // writeRolloutFixture already writes the fixture at codexHome/sessions,
  // so setting CODEX_HOME to codexHome lands getCodexUsage's internal
  // lookup exactly on our fixture without touching the real ~/.codex.
  const { codexHome } = writeRolloutFixture(SESSION_ID, lines)
  const prevCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome

  try {
    const usage = await getCodexUsage(SESSION_ID)
    assert.ok(usage, 'getCodexUsage must resolve real usage for a bound, existing session id')
    assert.equal(
      usage!.contextBudget,
      258400,
      'contextBudget must come straight from model_context_window'
    )
    // lastTurnContextTokens = input + cached_input + cache_write + output
    // from last_token_usage: 64491 + 63232 + 0 + 1415 = 129138
    assert.equal(
      usage!.lastTurnContextTokens,
      129138,
      'lastTurnContextTokens must sum the last-turn bucket the same way Claude’s accumulator does'
    )
    assert.equal(usage!.inputTokens, 643674, 'inputTokens must come from the CUMULATIVE bucket')
    assert.equal(
      usage!.cacheReadTokens,
      556800,
      'cacheReadTokens must map from cached_input_tokens'
    )

    const noBinding = await getCodexUsage(null)
    assert.equal(
      noBinding,
      null,
      'an unbound workspace (null claudeSessionId) must resolve to null, never throw'
    )

    const unknownId = await getCodexUsage('no-such-session-id')
    assert.equal(unknownId, null, 'an id with no matching rollout must resolve to null')
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodexHome
    fs.rmSync(codexHome, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 6. getCodexCost end-to-end — real pricing resolved for a Codex model id
//    via the shared model registry (verified empirically during this
//    unit's build: models.dev's `openai` bucket carries gpt-5.4 at
//    input $2.50/M, output $15/M, cache_read $0.25/M, no cache_write entry).
// ---------------------------------------------------------------------------
{
  const lines = [
    sessionMetaLine(SESSION_ID),
    realTurnContextLine('gpt-5.4'),
    realTokenCountLine({ totalTokens: 100_000, lastTotalTokens: 5_000, contextWindow: 400_000 })
  ]
  const { codexHome } = writeRolloutFixture(SESSION_ID, lines)
  const prevCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome

  try {
    if (modelsDevAvailable) {
      const cost = await getCodexCost(SESSION_ID)
      assert.ok(
        cost,
        'getCodexCost must resolve a real cost for a bound session with a known model'
      )
      assert.equal(
        cost!.hasUnknownPricing,
        false,
        'gpt-5.4 pricing is known (models.dev), must not report unknown'
      )
      // usd = (input/1e6)*2.5 + (output/1e6)*15 + (cache_read/1e6)*0.25 +
      // (cache_write/1e6)*0 — using the CUMULATIVE bucket's fixed real
      // values from realTokenCountLine (input_tokens: 643674, output_tokens:
      // 5155, cached_input_tokens: 556800, cache_write_input_tokens: 0).
      const expectedUsd =
        (643674 / 1_000_000) * 2.5 + (5155 / 1_000_000) * 15 + (556800 / 1_000_000) * 0.25
      assert.ok(
        Math.abs(cost!.usd - expectedUsd) < 1e-9,
        `cost.usd must match the real gpt-5.4 pricing math (expected ~${expectedUsd}, got ${cost!.usd})`
      )
    } else {
      console.warn(
        '[verify-codex-usage-reader] section 6 (real gpt-5.4 pricing): SKIPPED, no network'
      )
    }

    const noBinding = await getCodexCost(null)
    assert.equal(noBinding, null, 'an unbound workspace must resolve to null')
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodexHome
    fs.rmSync(codexHome, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 7. getCodexCost with an UNKNOWN model id -> hasUnknownPricing: true, usd:
//    0 — never a fabricated number.
// ---------------------------------------------------------------------------
{
  const lines = [
    sessionMetaLine(SESSION_ID),
    realTurnContextLine('some-future-model-id-not-in-any-catalog'),
    realTokenCountLine({ totalTokens: 1000, lastTotalTokens: 500, contextWindow: 128000 })
  ]
  const { codexHome } = writeRolloutFixture(SESSION_ID, lines)
  const prevCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome

  try {
    const cost = await getCodexCost(SESSION_ID)
    assert.ok(cost, 'a bound session with tokens must still resolve a (unknown-pricing) cost shape')
    assert.equal(
      cost!.hasUnknownPricing,
      true,
      'an unresolvable model id must set hasUnknownPricing, never a fabricated $0.00'
    )
    assert.equal(cost!.usd, 0, 'usd must stay 0 (not fabricated) when pricing is unknown')
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodexHome
    fs.rmSync(codexHome, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// FIRST-PARTY PRICING MUST WIN OVER A RESELLER'S.
//
// models.dev's flattened catalog is first-provider-wins, and for 6 of the 7
// Codex slugs a RESELLER bucket (ai-router, xpersona) outranks OpenAI's own.
// Measured against the live catalog, three of seven diverge and gpt-5.6-luna
// is wrong by 5x: ai-router publishes $1/$6 per M where OpenAI's own bucket
// says $0.20/$1.20. A cost five times too high still reads as authoritative,
// which is worse than showing nothing.
//
// Seeded deterministically (no network) with the REAL divergent numbers, so
// this asserts the actual hazard rather than a synthetic one.
// ---------------------------------------------------------------------------
{
  const modelsDev = await import('../src/main/models/sources/modelsDev.ts')
  const RESELLER = { input: 1, output: 6, cacheRead: 0, cacheWrite: 0 }
  const FIRST_PARTY = { input: 0.2, output: 1.2, cacheRead: 0, cacheWrite: 0 }

  modelsDev.setModelsDevCacheForTests(
    // The FLATTENED catalog holds the reseller's price — what resolveModel sees.
    { 'gpt-5.6-luna': { context: 258400, pricing: RESELLER, supportsReasoning: true } },
    [],
    // The openai-only bucket holds OpenAI's own — what cost must actually use.
    { 'gpt-5.6-luna': FIRST_PARTY }
  )

  const firstParty = modelsDev.getOpenAiPricingById('gpt-5.6-luna')
  assert.deepEqual(
    firstParty,
    FIRST_PARTY,
    "the openai-only bucket must return OpenAI's own price, not the flattened reseller entry"
  )
  assert.notDeepEqual(
    firstParty,
    RESELLER,
    'sanity: the fixture genuinely diverges — otherwise this assertion proves nothing'
  )

  // A model the openai bucket does NOT carry must report undefined, so the
  // caller can degrade to hasUnknownPricing rather than silently substituting
  // a reseller's number.
  assert.equal(
    modelsDev.getOpenAiPricingById('some-reseller-only-model'),
    undefined,
    'a model absent from the openai bucket must be undefined, never a flattened fallback'
  )

  // END-TO-END: getCodexCost itself must compute using the first-party
  // price, not just the raw getter above. A rollout bound to 'gpt-5.6-luna'
  // must produce a usd figure matching FIRST_PARTY math, never RESELLER
  // math — this is the actual behavior a wrong mutation (reverting to
  // resolveModel()) would break, and it is the assertion the mutation test
  // below exercises.
  const lines = [
    sessionMetaLine(SESSION_ID),
    realTurnContextLine('gpt-5.6-luna'),
    realTokenCountLine({ totalTokens: 100_000, lastTotalTokens: 5_000, contextWindow: 258400 })
  ]
  const { codexHome } = writeRolloutFixture(SESSION_ID, lines)
  const prevCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexHome

  try {
    const cost = await getCodexCost(SESSION_ID)
    assert.ok(cost, 'getCodexCost must resolve a cost for a session bound to a divergent model id')
    assert.equal(
      cost!.hasUnknownPricing,
      false,
      'gpt-5.6-luna is priced in the openai bucket fixture, must not report unknown'
    )
    // realTokenCountLine's CUMULATIVE bucket is fixed: input_tokens: 643674,
    // output_tokens: 5155, cached_input_tokens: 556800,
    // cache_write_input_tokens: 0 (cacheRead/cacheWrite are 0 for both
    // fixtures anyway, so only input/output can distinguish them).
    const firstPartyUsd =
      (643674 / 1_000_000) * FIRST_PARTY.input + (5155 / 1_000_000) * FIRST_PARTY.output
    const resellerUsd = (643674 / 1_000_000) * RESELLER.input + (5155 / 1_000_000) * RESELLER.output
    assert.ok(
      Math.abs(cost!.usd - firstPartyUsd) < 1e-9,
      `getCodexCost must use the FIRST-PARTY price (expected ~${firstPartyUsd}, got ${cost!.usd}) — ` +
        `the reseller price would have produced ~${resellerUsd}, a ${(resellerUsd / firstPartyUsd).toFixed(1)}x difference`
    )
    assert.ok(
      Math.abs(cost!.usd - resellerUsd) > 1e-6,
      'sanity: the fixture genuinely diverges from the reseller math — otherwise this assertion proves nothing'
    )
  } finally {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodexHome
    fs.rmSync(codexHome, { recursive: true, force: true })
  }

  modelsDev.setModelsDevCacheForTests(null)
}

console.log(
  '✓ Codex usage/cost reader: exact numbers from a real-shaped rollout, first-party pricing wins over a 5x-divergent reseller entry, null/unknown-pricing degrade honestly, never fabricates a context budget or a cost'
)
