// ---------------------------------------------------------------------------
// scripts/verify-overlay-window-api-purity.ts
//
// Regression guard for the model-routing unit 12 crash: RefreshModelsButton.tsx
// used to call window.api.routingProxy.refreshAuthFiles()/onRefreshProgress()
// (and, via refetchSelectableModels, window.api.models.*) directly — but it
// renders INSIDE the overlay's own, SEPARATE BrowserWindow (see
// overlayLayer.ts / OverlayRoot.tsx), whose preload (src/preload/overlay.ts)
// exposes ONLY `window.overlayApi` — there is no `window.api` there at all.
// Every one of those calls threw "Cannot read properties of undefined
// (reading 'routingProxy')" the moment a real user clicked the button,
// caught by OverlayErrorBoundary and surfaced as the "Something went wrong"
// crash card.
//
// typecheck/lint/every other verify-*.ts harness in this repo passed clean
// for that code: `window.api` is declared on the global `Window` type (see
// preload/index.d.ts), so every call type-checked fine — the failure is a
// RUNTIME window-boundary fact no static check in this repo's gate set
// observes on its own. This script is that check: a plain static scan
// (comments stripped, so this file's OWN doc comments discussing the bug in
// prose don't trip a false positive) asserting the literal string
// `window.api` never appears in the CODE of any file that renders inside
// the overlay window — every file under src/renderer/src/overlay/kinds/**,
// plus any component known to be imported by one of them despite living
// outside that directory (ADDITIONAL_OVERLAY_RENDERED_FILES below).
//
// Mirrors the existing scripts/verify-*.ts convention (a script run via
// `bun run`, the `test:overlay-purity` package.json script) but is
// deliberately a filesystem/static-analysis check rather than a pure-
// function assertion — this bug class is architectural (which BrowserWindow
// a component renders in), not a logic error a plain unit test could ever
// catch.
//
// Must be run from the repo root (package.json's `bun run scripts/...`
// convention already guarantees this).
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()
const OVERLAY_KINDS_DIR = join(REPO_ROOT, 'src/renderer/src/overlay/kinds')

/**
 * Components that render INSIDE the overlay window despite living outside
 * overlay/kinds/ — maintained explicitly (short list by design). Add to this
 * whenever a NEW shared component is imported by an overlay kind file and
 * therefore also runs in that window.
 */
const ADDITIONAL_OVERLAY_RENDERED_FILES = [
  join(REPO_ROOT, 'src/renderer/src/components/RefreshModelsButton.tsx')
]

/**
 * Strips `//` line comments and `/* *\/` block comments — best-effort, not a
 * full TS parser (good enough for this guard: the files it scans are plain
 * TSX/TS, and the goal is only to stop a doc comment that discusses
 * "window.api" in prose — like this very file's own header above, and
 * RefreshModelsButton.tsx's own post-fix history comment — from tripping a
 * false positive on the literal string).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function listFilesRecursive(dir: string, exts: string[]): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...listFilesRecursive(full, exts))
    } else if (exts.some((ext) => entry.endsWith(ext))) {
      out.push(full)
    }
  }
  return out
}

const filesToCheck = [
  ...listFilesRecursive(OVERLAY_KINDS_DIR, ['.ts', '.tsx']),
  ...ADDITIONAL_OVERLAY_RENDERED_FILES
]

let checked = 0
for (const file of filesToCheck) {
  const source = readFileSync(file, 'utf8')
  const codeOnly = stripComments(source)
  assert.ok(
    !codeOnly.includes('window.api'),
    `${file} references window.api in its CODE (not just a comment) — overlay-rendered code has NO ` +
      "window.api at runtime (the overlay window's preload, src/preload/overlay.ts, exposes ONLY " +
      'window.overlayApi). This is exactly the crash class fixed in model-routing unit 12 ' +
      '(RefreshModelsButton.tsx used to call window.api.routingProxy.* directly and crashed on the ' +
      'first real click). Move the window.api call to the MAIN-window "smart half" that owns this ' +
      'popover (mirroring useRefreshModelsController.ts) and thread the result down as a prop instead.'
  )
  checked++
}

assert.ok(checked > 0, 'sanity: this guard must actually check at least one file')

console.log(
  `✓ ${checked} overlay-rendered file(s) checked (every file under src/renderer/src/overlay/kinds/**, ` +
    'plus RefreshModelsButton.tsx) — none reference window.api in code'
)

console.log('\nAll overlay window.api purity assertions passed.')
