# Setup Orpheus

**Surface:** main-window / first-run setup
**Status:** ✅ Locked (Electron revamp, v0.6) — replaces the removed API-key onboarding gate; v0.6 re-imagining of v0.5 W18 (`old-plans/wireframes-v0.5.md`)
**Inspiration:** Conductor.build's "Setup Conductor" — provider-status cards + intentional "Finish setup" gate. Pared down to match Orpheus's smaller v0 surface area (Claude Code only, no theme switching, no audio prefs in onboarding).
**Shown when:** `setupCompleted` flag is false in `~/Library/Application Support/Orpheus/config.json` (first launch only)
**Dismissed by:** clicking **Finish setup** (or pressing ⌘↩) → flag set to `true`, app routes to `MainPage`

---

## Layout

```
┌───────────────────────────────────────────────────────────────────────────────────────────────┐  ← 1280 × 800 window
│ [o o o]                                                                                       │  ← 36px hidden-inset drag strip (existing)
│                                                                                               │
│                                                                                               │
│                                       Orpheus.                                                │  ← wordmark, text-4xl bold, "." in accent gold
│                                  Let's get you set up.                                        │  ← text-sm, text-text-secondary, centered
│                                                                                               │
│                                                                                               │  ~48px gap
│   ┌──────────────────────────────────────┐  ┌──────────────────────────────────────┐         │
│   │  ◆  Claude Code                      │  │  +  More providers                   │         │  provider cards row
│   │     Anthropic's coding agent.        │  │     GitHub, agents, and more —       │         │
│   │                                      │  │     coming soon.                     │         │
│   │  ✓ Connected · v2.1.138              │  │  Provider docs  ↗                    │         │
│   └──────────────────────────────────────┘  └──────────────────────────────────────┘         │
│                                                                                               │
│                                                                                               │
│                                                                                               │  flex spacer — page is intentionally
│                                                                                               │  sparse; more providers / settings
│                                                                                               │  will fill this area in later versions
│                                                                                               │
│                                                                                               │
│                                                                                               │
│                                                                          [ Finish setup ⌘↩ ]  │  footer right
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Elements

### Header
- **Wordmark** — "Orpheus." centered, `text-4xl font-bold tracking-tight text-text-primary`, final `.` in `text-accent`. Reused from `MainPage` — appears on every first-impression surface.
- **Subtitle** — "Let's get you set up." — `text-sm text-text-secondary`, centered directly under the wordmark.

### Provider cards (row)
Two cards, equal width (~360px each), 16px gap, centered horizontally on the page. Each card: `bg-surface-raised`, `border border-border-default`, `rounded-lg`, 16px padding.

**Claude Code card:**
- Icon top-left (◆ accent-gold mark, or a future Anthropic-style glyph)
- Name (bold, `text-text-primary`): "Claude Code"
- Description (`text-sm text-text-secondary`): "Anthropic's coding agent."
- Status row (separated by ~12px gap):
  - Installed: `✓ Connected · v{version}` — checkmark in `text-accent`, version in `text-text-secondary`
  - Missing: `⚠ Not installed` + small monospaced install command in a `bg-surface-overlay` block + a `Re-check` link

**More providers card:**
- Icon top-left (`+` in `text-text-muted`)
- Name (`text-text-secondary`): "More providers"
- Description (`text-sm text-text-muted`): "GitHub, agents, and more — coming soon."
- Bottom row: link `Provider docs ↗` (opens a placeholder external page for v0)

### Footer
Bottom-right cluster only:
- `[ Finish setup ⌘↩ ]` primary Button — disabled until `claudeInstalled === true`

No page dots (single page). No Get-support link (user can reach support from Settings later when that surface lands).

---

## States

1. **Loading** — doctor IPC in flight (~<100ms). Render nothing inside the page area to avoid flicker.
2. **Setup needed, Claude installed** — as drawn above. Finish setup button enabled.
3. **Setup needed, Claude missing** — Claude Code card switches its status row:
   ```
   ┌──────────────────────────────────────┐
   │  ◆  Claude Code                      │
   │     Anthropic's coding agent.        │
   │                                      │
   │  ⚠ Not installed                     │
   │  ┌─────────────────────────────────┐ │
   │  │ curl -fsSL claude.ai/install|sh │ │
   │  └─────────────────────────────────┘ │
   │  Re-check                            │
   └──────────────────────────────────────┘
   ```
   Finish setup button is disabled until `Re-check` confirms install.
4. **Setup completed** — page is not shown. App.tsx reads `setupCompleted: true` and routes to `MainPage`.

---

## Behaviors

- **Doctor check** runs on first render (`window.api.doctor.check()`). Result populates the Claude Code card status row.
- **Re-check link** re-runs the doctor IPC and updates the card in place — no full page reload.
- **Finish setup button** — writes `{ "setupCompleted": true }` to config.json, transitions to `MainPage`. Disabled when `claudeInstalled === false`. Keyboard shortcut ⌘↩.
- **Subsequent launches** — App.tsx reads `setupCompleted` flag from config.json. If true, skip this page entirely and render `MainPage`.

---

## Design tokens

| Region | Token |
|---|---|
| Page bg | `bg-surface-base` |
| Cards | `bg-surface-raised` |
| Install-command block (missing state) | `bg-surface-overlay` |
| Borders | `border-border-default` |
| Wordmark | `text-text-primary` + `.` in `text-accent` |
| Subtitle / card descriptions | `text-text-secondary`, `text-text-muted` for tertiary |
| Checkmark / Finish-setup button | `text-accent` / `bg-accent` |
| Card radius | `rounded-lg` |
| Button radius | `rounded-md` |

---

## Build notes

- The existing `MissingClaude.tsx` is subsumed by this surface — the Claude Code card's status row covers the same job. When this lands, delete `MissingClaude.tsx`.
- The existing `MainPage.tsx` stays unchanged — it's the post-setup welcome / projects-list view that this page hands off to.
- `setupCompleted` flag lives in `~/Library/Application Support/Orpheus/config.json`. Plain JSON, single field: `{ "setupCompleted": boolean }`. No encryption (no sensitive data).
- Single-page surface. If providers / preferences expand later, this evolves into a multi-page wizard with page dots above the footer.
- Page is intentionally sparse for v0 — the empty vertical space below the cards is real estate that fills in as the v0 surface area grows.

---

## Decisions (locked 2026-05-11)

- **Orpheus wordmark on top** — accent-gold dot treatment, same as `MainPage`. Brand mark appears on every first-impression surface.
- **"More providers" placeholder card stays** — v0 is Claude Code only; the placeholder communicates the future direction (GitHub, additional agents) without committing implementation.
- **No theme selector** — Orpheus is dark-mode only for v0. No Light / System options visible.
- **No completion-sound selector in onboarding** — defaults apply; users can adjust later via the Settings surface (W12 in v0.5; W12 v0.6 TBD).
- **No "Get support" link in setup** — support surfaces (GitHub Issues, docs links) live in Settings, not in the setup gate.
- **"Found in Claude Code" projects list stays on `MainPage`** — setup is for configuration confirmation, not project import. Project list is a post-setup welcome affordance.
- **Finish setup button is disabled when Claude Code is missing** — setup means ready-to-use. User must resolve the Claude install before proceeding.

---

## Iterative wireframing note

This wireframe is the v0.6 (Electron-era) re-imagining of the Swift-era v0.5 W18 onboarding (`old-plans/wireframes-v0.5.md`). The expectation going forward: as we adapt more surfaces from v0.5, each gets its own file in `docs/wireframes/` rather than being patched in-place in the old-plans archive. The Swift-era doc remains the historical reference; this directory accumulates the Electron-era replacements one surface at a time.
