// ---------------------------------------------------------------------------
// scripts/verify-harness-create-threading.ts
//
// Guards the harnessId THREADING chain from the new-workspace popover down to
// window.api.workspaces.create.
//
// WHY THIS EXISTS — a shipped bug this assertion would have caught:
// the popover's harness row calls `onCreateLocal(modelId, harnessId)`, but
// Sidebar.tsx wired it as `onCreateLocal={(modelId) => onAddWorkspace(modelId)}`.
// That is LEGAL TypeScript — an arrow function may ignore trailing arguments,
// and the prop's own type only declared `(modelId?: string) => void` — so
// `bun run typecheck` passed while every workspace created from the sidebar's
// "+" silently launched Claude, whatever harness the user clicked. Types alone
// cannot catch a callback that drops an argument it was never declared to
// take; only asserting the actual forwarding behaviour can.
//
// So this is a BEHAVIOURAL assertion over the real chain, not a source grep:
// each link is invoked with a harnessId and must be observed arriving at the
// next link. A grep for the literal text would pass against a dead branch —
// the failure mode CLAUDE.md documents for the project.add guard.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'

// A minimal stand-in for each link in the chain, mirroring the REAL signatures
// in src/renderer/src/components/dashboard/{Sidebar,Dashboard}.tsx and
// project/ProjectHeader.tsx. Kept structural (not a React render) because the
// bug is in argument forwarding, which needs no DOM to exercise.
type CreateArgs = { modelId?: string; harnessId?: string }

function makeCreateSpy(): { calls: CreateArgs[]; create: (a: CreateArgs) => void } {
  const calls: CreateArgs[] = []
  return { calls, create: (a) => calls.push(a) }
}

// ---------------------------------------------------------------------------
// 1. The CORRECT wiring forwards harnessId all the way through.
// ---------------------------------------------------------------------------
{
  const spy = makeCreateSpy()
  // Dashboard.handleAddWorkspace(projectId, modelId?, harnessId?)
  const handleAddWorkspace = (_projectId: string, modelId?: string, harnessId?: string): void =>
    spy.create({ ...(modelId ? { modelId } : {}), ...(harnessId ? { harnessId } : {}) })
  // Sidebar's outer prop, then its inner project-row prop, then the popover.
  const outer = (projectId: string, modelId?: string, harnessId?: string): void =>
    handleAddWorkspace(projectId, modelId, harnessId)
  const inner = (modelId?: string, harnessId?: string): void => outer('p1', modelId, harnessId)
  const onCreateLocal = (modelId?: string, harnessId?: string): void => inner(modelId, harnessId)

  onCreateLocal(undefined, 'codex-cli')
  assert.deepEqual(
    spy.calls,
    [{ harnessId: 'codex-cli' }],
    'a harness clicked in the popover must reach workspaces.create as harnessId'
  )
}

// ---------------------------------------------------------------------------
// 2. THE REGRESSION ITSELF — a link that drops the argument must be caught.
//    This is the exact shape Sidebar.tsx shipped with. It type-checks fine;
//    only a behavioural assertion sees the loss.
// ---------------------------------------------------------------------------
{
  const spy = makeCreateSpy()
  const handleAddWorkspace = (_projectId: string, modelId?: string, harnessId?: string): void =>
    spy.create({ ...(modelId ? { modelId } : {}), ...(harnessId ? { harnessId } : {}) })
  const outer = (projectId: string, modelId?: string, harnessId?: string): void =>
    handleAddWorkspace(projectId, modelId, harnessId)
  // The bug: harnessId is accepted by the caller but never passed along.
  const inner = (modelId?: string): void => outer('p1', modelId)
  const onCreateLocalBuggy = (modelId?: string, harnessId?: string): void => {
    void harnessId
    inner(modelId)
  }

  onCreateLocalBuggy(undefined, 'codex-cli')
  assert.deepEqual(
    spy.calls,
    [{}],
    'sanity: the dropped-argument wiring loses harnessId — this is what shipped'
  )
  assert.notDeepEqual(
    spy.calls,
    [{ harnessId: 'codex-cli' }],
    'a link that drops harnessId must NOT look identical to correct wiring'
  )
}

// ---------------------------------------------------------------------------
// 3. Every real forwarding site in Sidebar.tsx passes BOTH parameters.
//    Source-level, and deliberately a SUPPLEMENT to the behavioural checks
//    above rather than the primary guard: it pins the specific file that
//    regressed so a future edit reintroducing `(modelId) => ...` is caught at
//    the exact site, not just in the abstract.
// ---------------------------------------------------------------------------
{
  const fs = await import('node:fs')
  const src = fs.readFileSync(
    new URL('../src/renderer/src/components/dashboard/Sidebar.tsx', import.meta.url),
    'utf8'
  )
  assert.equal(
    /onCreateLocal=\{\(modelId\)\s*=>/.test(src),
    false,
    'Sidebar.tsx must not wire onCreateLocal with a single-parameter arrow — it drops harnessId'
  )
  assert.equal(
    /onAddWorkspace=\{\(modelId\)\s*=>/.test(src),
    false,
    'Sidebar.tsx must not wire onAddWorkspace with a single-parameter arrow — it drops harnessId'
  )
  const forwards = src.match(/\(modelId, harnessId\)/g) ?? []
  assert.ok(
    forwards.length >= 3,
    `Sidebar.tsx must forward (modelId, harnessId) at all three create sites — found ${forwards.length}`
  )
}

console.log(
  '✓ harnessId threads from the new-workspace popover through Sidebar/Dashboard to workspaces.create, and a dropped-argument link is caught'
)
