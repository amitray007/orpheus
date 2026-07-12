// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/DiffWorkerPoolProvider.tsx
//
// Pierre adoption Batch 2b (scratchpad/pierre-roadmap.json, "Worker pool via
// WorkerPoolContextProvider") — moves @pierre/diffs' Shiki tokenization +
// word/char diff off the renderer main thread and onto a pooled set of Web
// Workers. Without this, <PatchDiff>/<File> tokenize synchronously on the
// main thread on every mount (the remaining large-file cost after Batch 2a's
// <Virtualizer> wrap cut DOM size, not tokenize cost).
//
// SINGLETON, APP-WIDE: mounted once here (wrapping <Dashboard> in App.tsx),
// NOT per-workspace/per-pane. @pierre/diffs' own WorkerPoolContextProvider
// (dist/react/WorkerPoolContext.js) already calls
// getOrCreateWorkerPoolSingleton internally and ref-counts mounts
// (useInsertionEffect instanceCount++/--, terminating the pool only when the
// count reaches 0) — so even if this were mounted at multiple call sites
// they'd share one pool. We still mount it exactly once, at the top of the
// tree, so every workspace's Git/Files tabs share the same worker pool
// instead of paying pool-spin-up cost per workspace.
//
// <PatchDiff>/<File> read this pool from React context automatically
// (disableWorkerPool defaults to false in both) — GitTab.tsx and
// FilesTab.tsx need NO per-component change; they just need to render
// underneath this provider, which they do (WorkbenchPanel -> GitTab/FilesTab,
// WorkbenchPanel itself renders under Dashboard).
//
// CSP: verified against Orpheus's actual renderer CSP (src/renderer/index.html
// — `default-src 'self'; script-src 'self'; ...`, no `worker-src` directive,
// so per the CSP fallback chain workers are governed by `script-src 'self'`).
// A `new Worker(new URL(...))` referencing a BUNDLED same-origin chunk is
// allowed; a `blob:` worker would NOT be (no `blob:` in script-src). Verified
// electron-vite (Vite 7) DOES emit `@pierre/diffs/worker/worker-portable.js`
// as a real same-origin chunk (`assets/worker-portable-*.js`) resolved via a
// RELATIVE `new URL("worker-portable-*.js", import.meta.url)` — matching how
// Shiki's own per-language chunks already resolve under the packaged app's
// `file://` origin — provided `worker: { format: 'es' }` is set in
// electron.vite.config.ts (Vite's default `iife` format cannot code-split,
// and the worker bundle triggers a code-split for its WASM-engine branch).
// Confirmed via a real packaged-app CDP session: the worker script loads
// from `file:///.../app.asar/out/renderer/assets/worker-portable-*.js` with
// zero CSP console errors, and a real highlightFileAST() call round-trips a
// fully tokenized Shiki AST back from the worker.
//
// `worker-portable.js` (not `worker.js`) is used deliberately: it's the
// fully self-contained bundle (zero top-level `import` statements — all
// deps, including Shiki, are inlined), which resolves cleanly under a
// bundler without additional import-graph resolution. Its only dynamic
// `import()` is gated behind `preferredHighlighter === 'shiki-wasm'`, which
// we never select (see below) — the WASM/Oniguruma engine's chunk
// (`wasm-*.js`) is code-split off but never fetched.
//
// preferredHighlighter: 'shiki-js' (Shiki's pure-JS regex engine,
// createJavaScriptRegexEngine()) is passed explicitly — mirrors the
// CSP-driven engine choice already documented in diffHighlighterPreload.ts
// (the renderer's CSP has no `wasm-unsafe-eval`, so the Oniguruma/WASM
// engine would be unsafe to select even off the main thread; a worker
// script that never needs `unsafe-eval` also more comfortably respects
// script-src 'self' with no exceptions).
// ---------------------------------------------------------------------------

import type { ReactNode } from 'react'
import { WorkerPoolContextProvider } from '@pierre/diffs/react'

// Same pragmatic language set diffHighlighterPreload.ts warms on the main
// thread — keeps the worker pool's initial grammar set aligned with what the
// main-thread shared highlighter already preloads, so neither path cold
// resolves a grammar the other already has.
const WORKER_POOL_LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'python',
  'shellscript',
  'markdown',
  'yaml',
  'swift',
  'c',
  'cpp',
  'objective-c'
] as const

function createDiffWorker(): Worker {
  return new Worker(new URL('@pierre/diffs/worker/worker-portable.js', import.meta.url), {
    type: 'module'
  })
}

// useTokenTransformer: true — REQUIRED for token-hover (Pierre adoption Batch 3,
// GitTab.tsx/FilesTab.tsx's onTokenEnter/onTokenLeave wiring + TokenHoverPopover).
// When this pool is active, DiffHunksRenderer.getRenderOptions()/FileRenderer's
// equivalent fully ignore each <PatchDiff>/<File> instance's own
// onTokenEnter/onTokenLeave-derived useTokenTransformer and instead use this
// pool-wide, worker-manager-owned option (WorkerPoolManager defaults it to
// false, and nothing in @pierre/diffs ever calls setRenderOptions to flip it
// afterward — it's the host app's job). Without this, no token span gets the
// data-char attribute the hover feature depends on, so the popover never
// appears — confirmed via live CDP session (zero data-char attributes on any
// token). Since GitTab.tsx and FilesTab.tsx always wire the token-hover
// handlers unconditionally, there's no case where this pool should tokenize
// without the data-char markup, so it's set once here, app-wide.
export function DiffWorkerPoolProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <WorkerPoolContextProvider
      poolOptions={{ workerFactory: createDiffWorker }}
      highlighterOptions={{
        langs: [...WORKER_POOL_LANGS],
        preferredHighlighter: 'shiki-js',
        useTokenTransformer: true
      }}
    >
      {children}
    </WorkerPoolContextProvider>
  )
}
