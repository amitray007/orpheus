# Dashboard — Layout Shell

**Surface:** main-window / dashboard (post-onboarding state, claude detected)
**Status:** 🔄 Proposed (Electron revamp, v0.6) — adapts Swift-era W1/W2; **structure-first scope** (layout shell with "coming soon" placeholders for content sections)
**Shown when:** `doctor.claudeInstalled === true` (i.e., the ClaudeMissingModal is not active). This is the home surface — what the user sees on every launch once `claude` is detected.
**Replaces:** the current minimal `MainPage` (whose welcome + CC list responsibilities are absorbed into the dashboard structure)

---

## Layout

### Expanded sidebar (default state)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  ☰  Orpheus.                                                       ⚙    │  topbar 36px (drag)
├──────────────────┬───────────────────────────────────────────────────────────────┤
│                  │                                                                │
│  ▣  Dashboard    │  ACTIVITY                                                      │  ← section heading
│  ⌕  Sessions     │  ┌────────────────────────────────────────────────────────┐   │
│                  │  │                                                        │   │
│  ──  PINNED  ──  │  │  (coming soon)                                         │   │
│                  │  │                                                        │   │
│  (empty)         │  └────────────────────────────────────────────────────────┘   │
│                  │                                                                │
│  ── PROJECTS ──  │  RECENT PROJECTS                                               │
│              [+] │  ┌────────────────────────────────────────────────────────┐   │
│                  │  │                                                        │   │
│  (coming soon)   │  │  (coming soon)                                         │   │
│                  │  │                                                        │   │
│                  │  └────────────────────────────────────────────────────────┘   │
│                  │                                                                │
│                  │  RECENT SESSIONS                                               │
│                  │  ┌────────────────────────────────────────────────────────┐   │
│                  │  │                                                        │   │
│                  │  │  (coming soon)                                         │   │
│                  │  │                                                        │   │
│                  │  └────────────────────────────────────────────────────────┘   │
│                  │                                                                │
├──────────────────┴───────────────────────────────────────────────────────────────┤
│  Orpheus 0.0.1                                                       • Connected │  footer 28px
└──────────────────────────────────────────────────────────────────────────────────┘
   240px              flex-1 main area
```

### Collapsed sidebar (after clicking ☰)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  ☰  Orpheus.                                                       ⚙    │
├─────┬────────────────────────────────────────────────────────────────────────────┤
│     │                                                                            │
│  ▣  │  ACTIVITY                                                                  │
│  ⌕  │  ┌────────────────────────────────────────────────────────────────────┐   │
│     │  │                                                                    │   │
│  ╌  │  │  (coming soon)                                                     │   │
│     │  │                                                                    │   │
│  ╌  │  └────────────────────────────────────────────────────────────────────┘   │
│ [+] │                                                                            │
│     │  RECENT PROJECTS                                                           │
│     │  ┌────────────────────────────────────────────────────────────────────┐   │
│     │  │                                                                    │   │
│     │  │  (coming soon)                                                     │   │
│     │  │                                                                    │   │
│     │  └────────────────────────────────────────────────────────────────────┘   │
│     │                                                                            │
│     │  RECENT SESSIONS                                                           │
│     │  ┌────────────────────────────────────────────────────────────────────┐   │
│     │  │                                                                    │   │
│     │  │  (coming soon)                                                     │   │
│     │  │                                                                    │   │
│     │  └────────────────────────────────────────────────────────────────────┘   │
│     │                                                                            │
├─────┴────────────────────────────────────────────────────────────────────────────┤
│  Orpheus 0.0.1                                                       • Connected │
└──────────────────────────────────────────────────────────────────────────────────┘
   56px              flex-1 main area
```

Sidebar collapse transitions from 240px ↔ 56px via CSS `transition-[width] duration-150 ease-out`.

---

## Elements

### Topbar (36px)

- Existing `TitleBarDragRegion` (36px transparent overlay with `-webkit-app-region: drag`) stays as-is
- Left: hamburger `☰` button (~36px hit area), `WebkitAppRegion: 'no-drag'`, hover state, accessible label "Toggle sidebar"
- Center: **Orpheus.** wordmark (small — `text-base font-semibold tracking-tight text-text-primary` with the `.` in `text-accent`). Smaller than `MainPage`'s `text-4xl` — this is identity, not the main feature.
- Right: settings gear `⚙` button, `WebkitAppRegion: 'no-drag'`, hover state, accessible label "Settings". Placeholder for v0 — clicking does nothing yet.

### Sidebar

- Width: 240px expanded / 56px collapsed. CSS transition on width.
- Background: `bg-surface-raised`. Right border: `border-r border-border-default`.
- Padding: `px-2 py-4` expanded, `px-2 py-4` collapsed (icons stay centered)

Top nav items (each ~36–40px tall, `rounded-md`, hover `bg-surface-overlay`):

- **▣ Dashboard** — active state: `bg-accent/10 border-l-2 border-accent text-text-primary`
- **⌕ Sessions** — inactive: `text-text-secondary hover:text-text-primary`

In collapsed mode: only the glyph shows, label hides. Tooltip on hover (defer to a later polish chunk).

Below nav, `mt-6`:

- **PINNED** section header — `text-xs font-medium uppercase tracking-wide text-text-muted`. Empty state shows nothing below the header. Header label hides when sidebar is collapsed.
- **PROJECTS** section header — same styling. Includes a small `[+]` button (right-aligned in the header row, accessible label "Add project") — placeholder, non-functional in shell chunk. Below header: "(coming soon)" text in `text-text-muted text-sm` (also hides when collapsed).

### Main content area

- Padding: `px-8 py-6`
- Three vertical sections, each composed of:
  - Section heading: `text-xs font-medium uppercase tracking-wider text-text-secondary mb-2`
  - Placeholder card: `bg-surface-raised border border-border-default rounded-lg p-8 text-sm text-text-muted` — body is just `(coming soon)` centered

Sections in order:

1. **ACTIVITY** — will host the contribution heatmap (W2)
2. **RECENT PROJECTS** — will host a 3–5 row recent projects list (W2)
3. **RECENT SESSIONS** — will host a 3–5 row recent sessions list (W2)

Gap between sections: `gap-6`.

### Footer (~28px)

- Background: `bg-surface-raised`, top border: `border-t border-border-default`
- Padding: `px-4 py-1.5`, `flex items-center justify-between`
- Left: `Orpheus 0.0.1` — `text-xs text-text-muted`. Version pulls from `package.json` (via Electron's `app.getVersion()` over IPC, or hardcode for v0 — see Build notes).
- Right: `• Connected` — small green/accent dot + `text-xs text-text-muted`. Indicates claude is detected. Only rendered when `doctor.claudeInstalled === true`; we don't show the footer at all during the missing-claude state (modal covers it).

---

## States

1. **Sidebar expanded** — default on launch.
2. **Sidebar collapsed** — after clicking ☰. Toggles back on next click.
3. **Loading** — doctor IPC in flight (~<100ms). Render nothing (avoid flicker; existing pattern).
4. **Claude missing** — `ClaudeMissingModal` overlays the dashboard; dashboard stays mounted underneath, dimmed by the modal's backdrop.

---

## Behaviors

- **Hamburger ☰** toggles sidebar width via React state (`useState`). For v0, state lives in component only — doesn't persist across launches. Persisting is a follow-up polish chunk.
- **Settings gear ⚙**, **nav items**, **[+] add-project button** — all visible but non-functional placeholders. Click → no-op (or `console.log` for debugging). They land later as their respective surfaces materialize.
- **"coming soon" placeholder cards** — static text. No skeleton animations yet (`boneyard-js` is available per `docs/libraries.md` when we start showing real loading content).

---

## Design tokens

| Region           | Token                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------- |
| Page bg          | `bg-surface-base`                                                                       |
| Topbar           | transparent over `bg-surface-base` (drag region overlays)                               |
| Sidebar bg       | `bg-surface-raised`                                                                     |
| Sidebar border   | `border-r border-border-default`                                                        |
| Footer bg        | `bg-surface-raised`                                                                     |
| Footer border    | `border-t border-border-default`                                                        |
| Section heading  | `text-xs font-medium uppercase tracking-wider text-text-secondary`                      |
| Placeholder card | `bg-surface-raised border border-border-default rounded-lg p-8 text-sm text-text-muted` |
| Active nav       | `bg-accent/10 border-l-2 border-accent text-text-primary`                               |
| Inactive nav     | `text-text-secondary hover:text-text-primary hover:bg-surface-overlay`                  |
| Connected dot    | `text-accent` or `bg-green-500` (green felt more "live" than gold for status)           |

---

## Decisions (locked 2026-05-11)

- **Sidebar collapsible** via hamburger ☰ in topbar (240px ↔ 56px, CSS transition).
- **Footer minimal** — app version + claude-connected dot. No workspace name / session count / sync status for v0.
- **Settings gear placeholder** in topbar right — non-functional in this chunk.
- **No CC-scan list yet** — `Found in Claude Code` surface is deferred to a later chunk per separate wireframes. PROJECTS section shows "coming soon" placeholder until persistence lands.
- **Wordmark stays in topbar** (small, with accent dot) — reinforces brand identity without dominating the main content.
- **No persistence of sidebar collapsed-state in v0** — useState only, resets on relaunch. Polish chunk later.

---

## Build notes

- New components under `src/renderer/src/components/dashboard/`:
  - `Dashboard.tsx` — top-level composition (Topbar + Sidebar + main + Footer)
  - `Topbar.tsx` — hamburger + wordmark + settings gear
  - `Sidebar.tsx` — nav items + sections + collapse-state aware rendering
  - `Footer.tsx` — version + connected status
- App.tsx routes: `<Dashboard />` when claude detected; `<ClaudeMissingModal>` continues to overlay
- The existing `MainPage.tsx` retires when this lands (delete the file). Its wordmark moves to the topbar; the CTAs and CC list are deferred to subsequent chunks.
- App version: for v0, read from `package.json` at build time via Vite's `import.meta.env` or expose via IPC (`app.getVersion()`). IPC is cleaner — add `app:getVersion()` to the existing IPC surface.
- Icons (☰, ▣, ⌕, ⚙, +) are unicode glyphs for v0. A proper icon library (Lucide is the leading candidate — small bundle, comprehensive) lands in a polish chunk when content fills in.

---

## Iterative wireframing note

This is the v0.6 layout shell — derived from but not identical to Swift-era W1/W2. The chunked content surfaces (heatmap, recent projects, recent sessions, projects sidebar list) each become their own follow-up wireframes / build chunks as they get filled in.
