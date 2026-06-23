#!/usr/bin/env node
// Fails if any file uses a raw overlay-positioning primitive WITHOUT also importing the
// sanctioned <Overlay>. Under opaque-on-top, an un-coordinated overlay renders invisibly
// behind the terminal. The guard catches all overlay flavors in this codebase:
//   - createPortal / FloatingPortal (portaled overlays)
//   - `fixed inset-0` (full-screen modal backdrops)
//   - `fixed z-` (positioned fixed popovers, e.g. ContextMenu — no portal)
//   - `top-full` / `bottom-full` (anchored absolute dropdowns, e.g. SplitButton — no portal)
// A file is OK if it's the primitive itself, an explicit ALLOW entry, OR it imports Overlay
// (positive signal that its overlay is coordinated).
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PATTERNS = [
  'createPortal',
  'FloatingPortal',
  'fixed inset-0',
  'fixed z-',
  'top-full',
  'bottom-full'
]
// Files allowed to use raw primitives without importing <Overlay>:
//   Overlay.tsx — the primitive itself.
//   WorkspaceTitleBar / Sidebar — already register via useOverlayOpen and intentionally
//     keep their @floating-ui FloatingPortal (the plan does not migrate them off floating-ui).
const ALLOW = new Set([
  'src/renderer/src/components/ui/Overlay.tsx',
  'src/renderer/src/components/dashboard/WorkspaceTitleBar.tsx',
  'src/renderer/src/components/dashboard/Sidebar.tsx',
  // WorkspaceView portals the WorkspaceTitleBar into the fixed topbar slot host —
  // a DOM mount-point relocation, not a coordinated overlay/popover. No opaque-on-top
  // concern, so it intentionally stays on createPortal.
  'src/renderer/src/components/dashboard/WorkspaceView.tsx'
])
const flagged = new Set()
for (const p of PATTERNS) {
  let out = ''
  try {
    out = execSync(`git grep -ln --fixed-strings "${p}" -- 'src/renderer/**/*.tsx'`, {
      encoding: 'utf8'
    })
  } catch {
    continue // no matches for this pattern
  }
  for (const file of out.split('\n').filter(Boolean)) flagged.add(file)
}
const violations = []
for (const file of flagged) {
  if (ALLOW.has(file)) continue
  const src = readFileSync(file, 'utf8')
  // Coordinated if it imports the Overlay primitive.
  if (/from ['"]@\/components\/ui\/Overlay['"]/.test(src) || /\bimport\b.*\bOverlay\b/.test(src))
    continue
  violations.push(file)
}
if (violations.length) {
  console.error('Overlay discipline violations (route through <Overlay> or add to ALLOW):')
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
console.log('overlay discipline OK')
