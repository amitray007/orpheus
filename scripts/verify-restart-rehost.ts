// ---------------------------------------------------------------------------
// scripts/verify-restart-rehost.ts
//
// Guards the fix for: "changing a Codex workspace's model does nothing until
// you close and reopen it."
//
// WHY IT HAPPENED: workspace terminals are tmux-hosted by default, and
// terminal:destroy only ever destroyed the libghostty SURFACE. CLAUDE.md
// states the consequence outright — destroying a surface "is a no-op for a
// tmux-hosted workspace". So handleRestart's destroy+remount hit
// hostWorkspace()'s idempotent has-session branch and REATTACHED to the same
// live harness process, with its original argv. The newly-composed model or
// effort never reached anything. Close/reopen worked only because
// performClose calls unhostWorkspace.
//
// The `rehost` flag makes the restart path (and ONLY that path) also tear
// down the tmux session. Archive/remove must NOT set it — they run their own
// unhostWorkspace in their own handlers.
//
// Asserted structurally: these are IPC wiring facts across four files
// (channel type, preload bridge, main handler, renderer call sites), and the
// main handler cannot be imported into a plain harness — it lives in
// index.ts, which reaches electron and the native addon. Every assertion
// below therefore pins a specific wiring site rather than re-deriving it.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'

const read = async (rel: string): Promise<string> => {
  const fs = await import('node:fs')
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
}

// ---------------------------------------------------------------------------
// 1. The channel carries the flag, and it is OPTIONAL — an absent flag must
//    keep the pre-existing behavior for every caller that never passes it.
// ---------------------------------------------------------------------------
{
  const ipc = await read('src/shared/ipc.ts')
  assert.match(
    ipc,
    /'terminal:destroy': \{ req: \[\{ workspaceId: string; rehost\?: boolean \}\]; res: void \}/,
    'terminal:destroy must accept an OPTIONAL rehost flag (optional so archive/remove are unchanged)'
  )
}

// ---------------------------------------------------------------------------
// 2. The main handler unhosts the tmux session — and AWAITS it. A
//    fire-and-forget unhost would let the renderer's remount race a
//    still-dying session and reattach to the very process being replaced.
// ---------------------------------------------------------------------------
{
  const main = await read('src/main/index.ts')
  const start = main.indexOf("handle('terminal:destroy'")
  assert.ok(start > 0, 'sanity: the terminal:destroy handler still exists')
  const handler = main.slice(start, start + 2600)

  assert.match(
    handler,
    /if \(rehost === true\)/,
    'the handler must branch on rehost — archive/remove must not pay for a teardown they already do'
  )
  assert.match(
    handler,
    /await unhostWorkspace\(/,
    'the tmux teardown must be AWAITED — an unawaited unhost races the remount'
  )
  assert.match(
    handler,
    /async \(_e, \{ workspaceId, rehost \}\)/,
    'the handler must be async to await the teardown'
  )
}

// ---------------------------------------------------------------------------
// 3. ONLY the restart path opts in. Archive and project-remove must keep
//    calling destroy WITHOUT the flag.
// ---------------------------------------------------------------------------
{
  const view = await read('src/renderer/src/components/dashboard/WorkspaceView.tsx')
  assert.match(
    view,
    /\.destroy\(workspace\.id, true\)/,
    'handleRestart must request a rehost — otherwise a restart cannot change the running process'
  )

  const dashboard = await read('src/renderer/src/components/dashboard/Dashboard.tsx')
  const optedIn = dashboard.match(/\.destroy\([^)]*,\s*true\s*\)/g) ?? []
  assert.deepEqual(
    optedIn,
    [],
    'Dashboard (archive / project-remove) must NOT request a rehost — those paths run their own ' +
      'unhostWorkspace, and double-tearing-down a dying workspace is redundant work'
  )
}

// ---------------------------------------------------------------------------
// 4. The preload bridge forwards the flag, and OMITS the key when falsy —
//    so an absent flag is literally absent on the wire, not `rehost: false`.
// ---------------------------------------------------------------------------
{
  const preload = await read('src/preload/index.ts')
  assert.match(
    preload,
    /destroy: \(workspaceId: string, rehost\?: boolean\): Promise<void> =>/,
    'the preload bridge must accept the optional flag'
  )
  assert.match(
    preload,
    /\.\.\.\(rehost \? \{ rehost: true \} : \{\}\)/,
    'the bridge must omit the key entirely when falsy, keeping the default-path payload byte-identical'
  )
}

console.log(
  '✓ a live restart tears down the tmux SESSION (awaited), so a changed model/effort reaches a fresh harness process — while archive/remove keep their existing single teardown'
)
