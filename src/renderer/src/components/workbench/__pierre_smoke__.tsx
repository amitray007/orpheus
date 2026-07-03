// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/__pierre_smoke__.tsx
//
// U1 (P0) — throwaway smoke test proving @pierre/trees + @pierre/diffs build
// and render under electron-vite (dev AND production `build:unpack`) before
// any real Workbench UI depends on them. Not part of the Workbench feature —
// isolated, off-by-default, and intended to be deleted once P4/P5 (U9/U10)
// land the real Files/Git tabs.
//
// Mount: only reachable via `?view=pierre-smoke` (mirrors the existing
// `?view=diag-console` escape hatch in main.tsx) AND only outside production
// builds (__ORPHEUS_MODE__ !== 'production', matching lib/overlayDevTest.ts's
// gating convention). Never referenced from WorkspaceView/Dashboard.
//
// Validates (see docs/learnings/pierre-libraries.md §8 open questions):
//  - @pierre/trees/react: useFileTree({ paths, search, initialExpansion }) ->
//    { model }, rendered via <FileTree model={model} style={{ height }} />.
//  - @pierre/diffs/react: <PatchDiff patch={...} options={{ theme, ... }} />
//    rendering a tiny fake unified diff with Pierre's bundled dark theme
//    (no hand-authored Shiki theme needed for this smoke test).
//  - preferredHighlighter defaults to 'shiki-js' (pure JS regex engine, no
//    WASM) when omitted — confirmed against
//    node_modules/@pierre/diffs/dist/highlighter/*.js at U1 execution time;
//    this smoke test deliberately does NOT set preferredHighlighter, so it
//    also exercises the default path.
//  - Shadow-DOM theming: both components render inside a shadow root: trees
//    reads --trees-theme-* custom properties set on the host wrapper (via
//    the exported `themeToTreeStyles`), diffs reads its own theme via the
//    `options.theme` prop (Pierre's bundled 'pierre-dark'/'pierre-light').
// ---------------------------------------------------------------------------

import { useMemo } from 'react'
import type React from 'react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import { themeToTreeStyles, type TreeThemeInput } from '@pierre/trees'
import { PatchDiff } from '@pierre/diffs/react'

const SMOKE_PATHS = ['README.md', 'src/index.ts', 'src/components/Button.tsx']

// Minimal Shiki/VS-Code-shaped theme-like object — just enough for
// themeToTreeStyles to derive --trees-theme-* variables consistent with
// Orpheus's dark palette + #7c8cff accent. Not a full Shiki theme; trees only
// reads a structural subset (bg/fg/colors), per ThemeLike in
// @pierre/trees/dist/theming/dist/modules/types.d.ts.
const SMOKE_TREE_THEME: TreeThemeInput = {
  name: 'orpheus-smoke-dark',
  type: 'dark',
  bg: '#15161a',
  fg: '#e6e6ea',
  colors: {
    'list.activeSelectionBackground': '#2a2c3a',
    'list.focusBackground': '#2a2c3a',
    'list.hoverBackground': '#1f2028',
    focusBorder: '#7c8cff',
    'textLink.foreground': '#7c8cff'
  }
}

const SMOKE_PATCH = `diff --git a/src/components/Button.tsx b/src/components/Button.tsx
index 1111111..2222222 100644
--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -1,5 +1,7 @@
 import type React from 'react'

-export function Button(): React.JSX.Element {
-  return <button>Click me</button>
+export function Button({ label }: { label: string }): React.JSX.Element {
+  return (
+    <button className="accent">{label}</button>
+  )
 }
`

function PierreTreeSmoke(): React.JSX.Element {
  const { model } = useFileTree({
    paths: SMOKE_PATHS,
    initialExpansion: 'open',
    search: true
  })

  const hostStyle = useMemo(() => {
    const vars = themeToTreeStyles(SMOKE_TREE_THEME)
    return { height: '260px', ...vars } as React.CSSProperties
  }, [])

  return (
    <div style={hostStyle}>
      <FileTree model={model} header={<strong>Smoke tree</strong>} style={{ height: '100%' }} />
    </div>
  )
}

function PierreDiffSmoke(): React.JSX.Element {
  return (
    <PatchDiff
      patch={SMOKE_PATCH}
      options={{
        theme: { dark: 'pierre-dark', light: 'pierre-light' },
        themeType: 'dark',
        diffStyle: 'unified'
      }}
      style={{ maxHeight: '360px' }}
    />
  )
}

/**
 * Dev-only smoke page for @pierre/trees + @pierre/diffs. Reached only via
 * `?view=pierre-smoke` (see main.tsx) and never rendered in production
 * builds. Throwaway — delete once U9 (Files tab) / U10 (Git tab) land real
 * usage of these libraries.
 */
export function PierreSmokePage(): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
        padding: '24px',
        background: '#0b0c0f',
        color: '#e6e6ea',
        minHeight: '100vh',
        fontFamily: 'system-ui, sans-serif'
      }}
    >
      <h1>@pierre smoke test (U1)</h1>
      <section>
        <h2>@pierre/trees</h2>
        <PierreTreeSmoke />
      </section>
      <section>
        <h2>@pierre/diffs</h2>
        <PierreDiffSmoke />
      </section>
    </div>
  )
}
