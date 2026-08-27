// ---------------------------------------------------------------------------
// scripts/verify-workspace-provider-icon.ts
//
// Bug fix (support-multi-harness): the sidebar's per-workspace provider icon
// (WorkspaceProviderIcon.tsx) rendered NOTHING for a Codex workspace, because
// useWorkspaceProviderIcon resolves a providerId ONLY from the workspace's
// effective MODEL via the selectable-model list — a Codex model never
// resolves to an entry in that (Claude-routing-only) list, so the hook
// always returned null for a Codex workspace and the icon slot rendered
// empty.
//
// Fix: WorkspaceProviderIcon.tsx now accepts an optional
// `harnessIconFallback` prop (Sidebar.tsx passes the workspace's own
// `useHarnessForWorkspace(...).icon`, a value it ALREADY computes for other
// capability gating — no new IPC/fetch). resolveWorkspaceProviderIconId is
// the pure two-tier decision extracted out of the component's JSX so it can
// be asserted directly, per CLAUDE.md's "assert behaviour, not source text"
// rule: model-derived providerId wins when present (regression bar — a
// Claude workspace on a routed/known model must render EXACTLY as before);
// otherwise the harness-icon fallback; otherwise null (still renders
// nothing, never a fabricated guess).
//
// Runs as a plain `bun run` script — WorkspaceProviderIcon.tsx imports
// `react` (type-only, for React.JSX.Element) and useWorkspaceProviderIcon.ts
// (a hook), but resolveWorkspaceProviderIconId itself is imported and called
// directly as a plain function — no rendering, no DOM, mirrors
// verify-harness-capability-gating.ts's approach of importing a .tsx/.ts
// module for its exported pure logic alone.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { resolveWorkspaceProviderIconId } from '../src/renderer/src/components/dashboard/WorkspaceProviderIcon.tsx'

// ---------------------------------------------------------------------------
// (a) Known model-provider present -> that provider wins over harness
//     fallback. THE REGRESSION BAR: a Claude workspace whose model resolves
//     must render identically to before this fix — the fallback path must
//     never override an already-resolved provider.
// ---------------------------------------------------------------------------

function testModelProviderWinsOverHarnessFallback(): void {
  assert.equal(
    resolveWorkspaceProviderIconId('claude', 'codex'),
    'claude',
    'a resolved model-derived provider must win even when a harness fallback is ALSO present ' +
      '(e.g. a mis-set/stale harness icon must never override a real model-derived provider)'
  )
  assert.equal(
    resolveWorkspaceProviderIconId('xai', undefined),
    'xai',
    'a resolved model-derived provider must render as-is when no harness fallback is provided at all'
  )
}

// ---------------------------------------------------------------------------
// (b) model-provider null + harness icon 'codex' -> 'codex' wins. This is
//     THE BUG FIX ITSELF: a Codex workspace's model never resolves via the
//     selectable-model list, so the model-derived tier is null, and the
//     harness-derived icon must now fill the sidebar row instead of leaving
//     it blank.
// ---------------------------------------------------------------------------

function testHarnessFallbackFillsWhenModelUnresolved(): void {
  assert.equal(
    resolveWorkspaceProviderIconId(null, 'codex'),
    'codex',
    'BUG FIX: a Codex workspace (model-derived provider null) must fall back to its harness icon ' +
      "so the sidebar row shows Codex's icon instead of nothing"
  )
}

// ---------------------------------------------------------------------------
// (c) model-provider null + harness icon undefined -> null (still renders
//     nothing, no fabricated fallback). Proves the fallback is narrow: an
//     absent harness icon (e.g. a future harness with no icon set) must not
//     synthesize a fake providerId.
// ---------------------------------------------------------------------------

function testNoFallbackAvailableStillRendersNothing(): void {
  assert.equal(
    resolveWorkspaceProviderIconId(null, undefined),
    null,
    'with neither tier resolved, the result must stay null (render nothing), not a fabricated guess'
  )
  assert.equal(
    resolveWorkspaceProviderIconId(null, null),
    null,
    'a null harness fallback (not just undefined) must also degrade to null, not throw or coerce oddly'
  )
}

// MUTATION: flip the resolution order (harness fallback wins over the
// model-derived provider) and confirm the regression-bar case (a) above
// would have been broken — a Claude workspace on a routed model would show
// the wrong icon whenever a harness fallback happens to be present too.
function testMutationFlippedPriorityOrder(): void {
  const mutatedResolve = (
    modelDerivedProviderId: string | null,
    harnessIconFallback: string | null | undefined
  ): string | null => {
    // MUTATION: harness fallback checked FIRST, inverting the real function's
    // "model wins" priority.
    if (harnessIconFallback) return harnessIconFallback
    return modelDerivedProviderId ?? null
  }

  try {
    assert.equal(
      mutatedResolve('claude', 'codex'),
      'claude',
      'the regression-bar case must still resolve to the model-derived provider'
    )
    throw new Error('mutation did not fail as expected')
  } catch (e) {
    assert.ok(
      e instanceof assert.AssertionError,
      'mutation must fail via AssertionError, not some other error'
    )
    console.log(
      `  mutation caught (expected failure) [priority order flipped, harness fallback checked before model provider]: ${(e as Error).message.split('\n')[0]}`
    )
  }
}

testModelProviderWinsOverHarnessFallback()
testHarnessFallbackFillsWhenModelUnresolved()
testNoFallbackAvailableStillRendersNothing()
testMutationFlippedPriorityOrder()

console.log('verify-workspace-provider-icon: all assertions passed')
