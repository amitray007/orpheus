# Setup Orpheus

**Surface:** main-window / first-run setup
**Status:** 🔄 Proposed (Electron revamp, v0.6) — replaces the removed API-key onboarding gate
**Inspiration:** Conductor.build's "Setup Conductor" screen — provider-status cards + visual setting selectors + intentional "Finish setup" gate
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
│                                                                                               │  ~40px gap
│   ┌──────────────────────────────────────┐  ┌──────────────────────────────────────┐         │
│   │  ◆  Claude Code                      │  │  +  More providers                   │         │  provider cards row
│   │     Anthropic's coding agent.        │  │     GitHub, agents, and more —       │         │
│   │                                      │  │     coming soon.                     │         │
│   │  ✓ Connected · v2.1.138              │  │  Provider docs  ↗                    │         │
│   └──────────────────────────────────────┘  └──────────────────────────────────────┘         │
│                                                                                               │
│                                                                                               │  ~40px gap
│   Theme  ⌘⌥T                                              ┌─────┐  ┌─────┐  ┌─────┐          │
│   Choose light, dark, or system.                          │ ◷   │  │ ◼   │  │ ◐   │          │  visual chips (mini-previews)
│                                                           └─────┘  └─────┘  └─────┘          │
│                                                            Light    Dark    System           │
│                                                           (soon)            (soon)           │
│                                                                                               │
│                                                                                               │
│   Completion sound                                                          ┌─────────┐  🔊  │  dropdown + preview button
│   Choose what plays when an agent finishes.                                 │ Chime ▾ │      │
│                                                                             └─────────┘      │
│                                                                                               │
│                                                                                               │
│                                                                                               │  flex spacer
│                                                                                               │
│                                                                ⓘ Get support  [ Finish setup ⌘↩ ] │  footer right
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Elements

### Header
- **Wordmark** — "Orpheus." centered, `text-4xl font-bold tracking-tight text-text-primary` with the final `.` in `text-accent` (same treatment as `MainPage` for cross-surface consistency). The wordmark is the brand mark; it appears on every first-impression surface (`MainPage`, `Setup`, future onboarding states).
- **Subtitle** — "Let's get you set up." — `text-sm text-text-secondary`, centered directly under the wordmark
- (No separate "Setup Orpheus" header — the wordmark + subtitle do the job, matching `MainPage`'s rhythm rather than Conductor's bold-title style.)

### Provider cards (row)
Two cards, equal width (~360px each), 16px gap. Each card: `bg-surface-raised`, `border border-border-default`, `rounded-lg`, 16px padding.

**Claude Code card:**
- Icon top-left (◆ accent-gold mark, or future Anthropic-themed glyph)
- Name (bold, `text-text-primary`): "Claude Code"
- Description (`text-sm text-text-secondary`): "Anthropic's coding agent."
- Status row (below, separated by ~12px):
  - Installed: `✓ Connected · v{version}` — checkmark in `text-accent`, version in `text-text-secondary`
  - Missing: `⚠ Not installed` + small monospaced install command + `Re-check` link

**More providers card:**
- Icon top-left (`+` in `text-text-muted`)
- Name (`text-text-secondary`): "More providers"
- Description (`text-sm text-text-muted`): "GitHub, agents, and more — coming soon."
- Bottom row: link `Provider docs ↗` → opens a placeholder docs page (real link TBD)

### Settings rows
Each row: full-width container, label-left / control-right, ~24px vertical padding.

**Theme  ⌘⌥T**
- Left:
  - Label: "Theme" (`text-base font-medium`)
  - Shortcut chip inline: `⌘⌥T` (`text-xs`, muted bg, small padding)
  - Description below: "Choose light, dark, or system." (`text-xs text-text-muted`)
- Right: three preview chips ~64×40px in a row, gap 8px
  - Each chip = mini-window preview (background + a couple of content lines drawn in the chip's local colors)
  - **Light** — visually disabled, "(soon)" subscript
  - **Dark** — selected (accent-gold ring `ring-2 ring-accent`)
  - **System** — visually disabled, "(soon)" subscript

**Completion sound**
- Left:
  - Label: "Completion sound" (`text-base font-medium`)
  - Description: "Choose what plays when an agent finishes." (`text-xs text-text-muted`)
- Right:
  - Dropdown (custom-styled to match palette): default "Chime"; options `Chime`, `Soft bell`, `Off`
  - Speaker icon button right of dropdown — plays a preview of the selected sound on click

### Footer
Fixed to bottom of the page area (above any window chrome), right-aligned cluster:
- `ⓘ Get support` link (`text-xs text-text-muted`) → opens external link (GitHub Issues for v0)
- `[ Finish setup ⌘↩ ]` primary Button — disabled until `claudeInstalled === true`

No page dots (single page for v0). If we add a page 2 later (e.g., GitHub auth + advanced prefs), introduce centered dots above the footer.

---

## States

1. **Loading** — doctor IPC in flight (~<100ms). Render nothing inside the page area to avoid flicker.
2. **Setup needed, Claude installed** — as drawn above. Finish setup button enabled.
3. **Setup needed, Claude missing** — Claude Code card switches status row to the "not installed" variant:
   ```
   ┌──────────────────────────────────────┐
   │  ◆  Claude Code                      │
   │     Anthropic's coding agent.        │
   │                                      │
   │  ⚠ Not installed                     │
   │  ┌─────────────────────────────────┐ │
   │  │ curl -fsSL claude.ai/install | sh│ │
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
- **Theme selector** — clicking Dark is a no-op (already dark); clicking Light or System does nothing for v0 (visibly disabled). Wiring real theme switching is post-v0.
- **Completion sound** — selection persists immediately (no Save button), value goes to `config.json`. Speaker icon plays a preview through the renderer's `Audio` API or the main process's `NSSound`.
- **Finish setup** — writes `{ "setupCompleted": true, "completionSound": "Chime" }` to config.json, transitions to `MainPage`. Keyboard shortcut ⌘↩.
- **Subsequent launches** — App.tsx reads `setupCompleted` flag from config.json. If true, skip this page entirely.

---

## Design tokens

| Region | Token |
|---|---|
| Page bg | `bg-surface-base` |
| Cards / settings backgrounds | `bg-surface-raised` |
| Borders | `border-border-default` |
| Title | `text-text-primary` |
| Subtitle / descriptions | `text-text-secondary`, `text-text-muted` for tertiary |
| Checkmarks / selected ring / primary button | `text-accent` / `ring-accent` / `bg-accent` |
| Disabled chip overlay | `opacity-40 cursor-not-allowed` |
| Card radius | `rounded-lg` |
| Button / chip radius | `rounded-md` |

---

## Build notes

- The existing `MissingClaude.tsx` is largely subsumed by this surface — the Claude Code card's status row covers the same job. When this lands, `MissingClaude.tsx` can be deleted (or kept as a fallback for an "abnormal" state where doctor IPC fails entirely).
- The existing `MainPage.tsx` stays — it's the post-setup welcome / projects-list view that this page hands off to.
- `setupCompleted` flag lives in the same `~/Library/Application Support/Orpheus/config.json` the API key briefly used. Plain JSON, no encryption.
- Single-page wireframe; Conductor uses 2 pages because they have richer config (GitHub auth, Codex login). If more providers / auth flows land for Orpheus later, this evolves into a wizard with page dots above the footer.
- The `Completion sound` row is optional polish. Drop if we want to keep this page strict for v0 and defer to a Settings page (W12).

---

## Decisions locked

- **"More providers" card stays.** v0 is Claude Code only; the placeholder card communicates the future direction (GitHub, additional agent backends) without us having to ship them yet. (Confirmed by user, 2026-05-11.)
- **Wordmark "Orpheus."** with the accent-gold dot is the brand mark on every first-impression surface. Reused from `MainPage`; consistent rhythm across surfaces.

## Open questions

- Should the existing "Found in Claude Code" projects list (currently on `MainPage`) move into this setup as a page 2, or stay on `MainPage` as the post-setup welcome state? **Lean:** keep it on `MainPage` — setup is for configuration, not project import.
- Sound catalog: just `Chime`? Multiple options? Volume? **Lean:** start with `Chime / Soft bell / Off`, no volume in v0.
- "Get support" target: GitHub Issues, a Discord, or an email? **Lean:** GitHub Issues for v0.
- Light / System theme chips: show disabled with "(soon)", or hide entirely until they work? **Lean:** show disabled — communicates the roadmap.
- "Finish setup" button: disable when Claude is missing, or always-enabled (let user proceed but show a warning in the app)? **Lean:** disable; setup should mean ready-to-use.

---

## Iterative wireframing note

This wireframe is the v0.6 (Electron-era) reimagining of the Swift-era v0.5 W18 onboarding (`old-plans/wireframes-v0.5.md`). The expectation going forward: as we adapt more surfaces from v0.5, each gets its own file in `docs/wireframes/` rather than being patched in-place in the old-plans archive. The Swift-era doc remains the historical reference; this directory accumulates the Electron-era replacements one surface at a time.
