// ---------------------------------------------------------------------------
// scripts/verify-worktree-paths.ts
//
// Behavior guard for src/shared/harness/worktreePaths.ts (H1 follow-up,
// support-multi-harness) — the per-harness worktree directory derivation:
// `.<harness>/worktrees/` instead of a hardcoded `.claude/worktrees/`.
// Asserts against the REAL exported functions, not a restatement of their
// logic — see CLAUDE.md: "Assert behaviour, not source text."
//
// RUNTIME CHOICE — plain `bun run`. worktreePaths.ts is deliberately
// dependency-free (no node:path, no DB, no Electron — see its own header),
// so this runs like the majority of this repo's verify-*.ts scripts.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import {
  worktreeDirSegment,
  worktreeGitignoreEntry,
  resolveWorktreeBaseRef
} from '../src/shared/harness/worktreePaths'

// ---------------------------------------------------------------------------
// worktreeDirSegment
// ---------------------------------------------------------------------------

assert.equal(
  worktreeDirSegment('claude'),
  '.claude/worktrees',
  "Claude's segment must be exactly '.claude/worktrees' — every existing repo's real on-disk worktrees and .gitignore entry depend on this staying byte-identical to the old hardcoded literal"
)
assert.equal(
  worktreeDirSegment('codex'),
  '.codex/worktrees',
  'a different harness id must derive a DIFFERENT segment, not fall back to claude'
)
assert.notEqual(
  worktreeDirSegment('claude'),
  worktreeDirSegment('codex'),
  'two different harness ids must never derive the same segment'
)

// ---------------------------------------------------------------------------
// worktreeGitignoreEntry
// ---------------------------------------------------------------------------

assert.equal(
  worktreeGitignoreEntry('claude'),
  '.claude/worktrees/',
  "must be BYTE-IDENTICAL to worktrees.ts's old hardcoded entry string (WITH the trailing slash) — ensureWorktreesGitignored's exact-line dedup check compares against this; any drift would cause every existing repo to get a SECOND, redundant .claude/worktrees/ line"
)
assert.equal(
  worktreeGitignoreEntry('codex'),
  '.codex/worktrees/',
  'a different harness gets its own gitignore entry, with the trailing slash'
)
assert.equal(
  worktreeGitignoreEntry('claude'),
  `${worktreeDirSegment('claude')}/`,
  'the gitignore entry is always the dir segment plus exactly one trailing slash — no double slash, no missing slash'
)

// ---------------------------------------------------------------------------
// resolveWorktreeBaseRef — the baseRef migration/fallback precedence
// ---------------------------------------------------------------------------

assert.equal(
  resolveWorktreeBaseRef(null, null),
  'fresh',
  'neither source has an opinion -> fresh (the ultimate default)'
)
assert.equal(
  resolveWorktreeBaseRef(undefined, undefined),
  'fresh',
  'undefined is treated the same as null for both inputs'
)
assert.equal(
  resolveWorktreeBaseRef(null, 'head'),
  'head',
  'THE MIGRATION CASE — app_ui_state unset, legacy ~/.claude/settings.json has head -> the legacy value survives, is not silently reset to fresh'
)
assert.equal(
  resolveWorktreeBaseRef('head', null),
  'head',
  'app_ui_state set -> wins even with no legacy value'
)
assert.equal(
  resolveWorktreeBaseRef('fresh', 'head'),
  'fresh',
  'app_ui_state ALWAYS wins over the legacy location once it has ANY opinion, even an explicit fresh overriding a legacy head — the new home is authoritative the moment it has a value, not merely when it agrees with the old one'
)

console.log('All worktree-paths assertions passed.')

// ---------------------------------------------------------------------------
// Mutation tests — break each load-bearing property, confirm the harness
// fails, then restore. Run LAST so a failure here can't mask an earlier
// real bug.
// ---------------------------------------------------------------------------

function mustFail(label: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.log(`  mutation caught (expected failure) [${label}]:`, (err as Error).message)
    return
  }
  throw new Error(`MUTATION TEST FAILED TO CATCH A BUG: ${label} did not throw`)
}

// Mutation 1 — every harness sharing Claude's directory (the exact bug this
// unit fixes: a second harness's worktrees silently landing under
// .claude/worktrees/ instead of their own directory).
mustFail('worktreeDirSegment ignoring harnessId, always returning claude', () => {
  // Signature intentionally drops the harnessId parameter — the bug being
  // simulated is "never looks at the argument at all".
  function brokenWorktreeDirSegment(): string {
    // BUG: hardcoded, ignores the parameter entirely.
    return '.claude/worktrees'
  }
  const real = worktreeDirSegment('codex')
  const broken = brokenWorktreeDirSegment()
  assert.equal(broken, real, 'a harness-blind segment must disagree with the real, derived one')
})

// Mutation 2 — gitignore entry missing the trailing slash (would break
// ensureWorktreesGitignored's exact-line dedup against the historical
// '.claude/worktrees/' string with the slash, causing re-adds on every run).
mustFail('worktreeGitignoreEntry dropping the trailing slash', () => {
  function brokenEntry(harnessId: string): string {
    // BUG: no trailing slash.
    return worktreeDirSegment(harnessId)
  }
  const real = worktreeGitignoreEntry('claude')
  const broken = brokenEntry('claude')
  assert.equal(broken, real, 'a slash-less entry must disagree with the real, slash-terminated one')
})

// Mutation 3 — a broken migration that silently resets a user's real legacy
// preference to 'fresh' instead of falling through to it. This is exactly
// the "silently reset someone's live preference" failure mode the user's
// instructions were explicit about avoiding.
mustFail('resolveWorktreeBaseRef discarding the legacy value instead of falling through', () => {
  // Signature intentionally drops the legacy-value parameter — the bug
  // being simulated is "never consults the fallback at all".
  function brokenResolve(appUiStateValue: 'fresh' | 'head' | null | undefined): 'fresh' | 'head' {
    // BUG: ignores the legacy fallback entirely — anyone with only the OLD
    // ~/.claude/settings.json value set (never having touched the new
    // location) gets silently reset to 'fresh'.
    if (appUiStateValue === 'head' || appUiStateValue === 'fresh') return appUiStateValue
    return 'fresh'
  }
  const real = resolveWorktreeBaseRef(null, 'head')
  const broken = brokenResolve(null)
  assert.equal(
    broken,
    real,
    "a migration that drops the legacy 'head' preference must disagree with the real, preference-preserving result"
  )
})

console.log('All worktree-paths mutation tests passed.')
