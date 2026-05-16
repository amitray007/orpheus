# Claude Code Required — Non-dismissible Modal

**Surface:** overlay / blocking modal (renders over `MainPage`)
**Status:** ✅ Locked (Electron revamp, v0.6) — replaces the dropped Setup screen for handling the Claude-missing state
**Shown when:** `doctor.claudeInstalled === false` on app launch, or after a re-check still fails
**Dismissed by:** A successful re-check (Claude detected on PATH) OR ⌘Q at the OS level
**NOT dismissed by:** Esc, backdrop click, in-app close button, or any in-app action — the app is non-functional without `claude`, so the modal is intentionally trapping

---

## Layout

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ [o o o]                                                                       │  ← traffic lights (red close → app.hide(), not quit)
│                                                                               │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │  ← dimmed backdrop (bg-black/60, optional backdrop-blur-sm)
│ ░░ MainPage visible behind backdrop, but not interactive ░░                   │
│ ░░░░░                                                                   ░░░░░ │
│ ░░░    ┌─────────────────────────────────────────────┐                 ░░░░░ │
│ ░░░    │                                             │                 ░░░░░ │
│ ░░░    │  ⚠  Claude Code required                    │                 ░░░░░ │  ← headline (text-lg, font-semibold)
│ ░░░    │                                             │                 ░░░░░ │
│ ░░░    │  Orpheus runs on the `claude` CLI.          │                 ░░░░░ │  ← body (text-sm, text-text-secondary)
│ ░░░    │  Install Claude Code to continue.           │                 ░░░░░ │
│ ░░░    │                                             │                 ░░░░░ │
│ ░░░    │  ┌─────────────────────────────────────┐    │                 ░░░░░ │
│ ░░░    │  │ curl -fsSL claude.ai/install.sh|sh  │    │                 ░░░░░ │  ← install command (bg-surface-overlay, font-mono)
│ ░░░    │  └─────────────────────────────────────┘    │                 ░░░░░ │
│ ░░░    │                                             │                 ░░░░░ │
│ ░░░    │  [ Re-check ]   Read docs ↗                 │                 ░░░░░ │  ← Re-check primary; docs link
│ ░░░    │                                             │                 ░░░░░ │
│ ░░░    │  Press ⌘Q to quit Orpheus.                  │                 ░░░░░ │  ← escape hatch hint (text-xs, muted)
│ ░░░    │                                             │                 ░░░░░ │
│ ░░░    └─────────────────────────────────────────────┘                 ░░░░░ │
│ ░░░░░                                                                   ░░░░░ │
│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## Elements

### Backdrop

- Full window-area overlay (`fixed inset-0`)
- `bg-black/60` (or `bg-surface-base/80` for a brand-tinted variant)
- Optional: `backdrop-blur-sm` for depth
- Click handlers: **none** — clicks pass through to the modal, not to MainPage. (`pointer-events-auto` on modal, `pointer-events-none` on MainPage below? No — backdrop captures clicks so the underlying content is visually present but not interactive.)

### Modal card

- `relative max-w-md w-full bg-surface-overlay border border-border-default rounded-lg p-6 flex flex-col gap-4`
- Centered horizontally and vertically within the backdrop
- No close button, no X in any corner

### Content

- **Icon + headline row**: ⚠ icon (`text-yellow-400`) + "Claude Code required" (`text-lg font-semibold text-text-primary`)
- **Body**: "Orpheus runs on the `claude` CLI. Install Claude Code to continue." — `text-sm text-text-secondary`, with `claude` styled as inline code (`text-accent font-mono`)
- **Install command**: monospaced `<pre>` block with `bg-surface-raised border border-border-default rounded px-3 py-2 text-xs font-mono text-text-primary`. Content: `curl -fsSL https://claude.ai/install.sh | sh` (placeholder — verify exact URL/command from Claude Code docs).
- **Action row**: `[ Re-check ]` primary Button + `Read docs ↗` link to `https://docs.claude.com/en/docs/claude-code`
- **Escape-hatch hint**: "Press ⌘Q to quit Orpheus." — `text-xs text-text-muted`, bottom of card

---

## States

1. **Hidden** — `doctor.claudeInstalled === true`. Modal is not rendered.
2. **Visible** — `doctor.claudeInstalled === false`. Modal blocks the entire app surface.
3. **Re-checking** — Re-check button is in loading state while doctor IPC runs. Other interactions disabled during the in-flight check.

---

## Behaviors

- Renders as a sibling of `MainPage` inside `App.tsx`. MainPage stays mounted underneath (so it doesn't flash in/out as the modal toggles); the backdrop covers it.
- **No Esc dismiss**, **no backdrop-click dismiss**, **no close button** — strictly non-dismissible in-app.
- **Re-check button** runs `window.api.doctor.check()`. If `claudeInstalled` becomes true, the modal unmounts and the user lands on a live MainPage.
- **Read docs link** opens external (handled by Electron's `setWindowOpenHandler` → `shell.openExternal`).
- **⌘Q** quits the app via the existing `before-quit` handler (sets `isQuitting=true`, lets the close handler skip the `app.hide()` short-circuit).
- **Red close button** → `app.hide()` (existing focus-yield behavior). On next dock-icon click the app reappears with the modal still up — the modal is the source of truth on Claude state.

---

## Design tokens

| Region                    | Token                                                       |
| ------------------------- | ----------------------------------------------------------- |
| Backdrop                  | `bg-black/60` (optional `backdrop-blur-sm`)                 |
| Modal card                | `bg-surface-overlay`, `border-border-default`, `rounded-lg` |
| Install command block     | `bg-surface-raised`, `border-border-default`                |
| Headline icon             | `text-yellow-400` (warning)                                 |
| Inline code `claude`      | `text-accent font-mono`                                     |
| Primary button (Re-check) | `bg-accent text-accent-on`                                  |
| Docs link                 | `text-text-secondary hover:text-text-primary`               |
| Escape-hatch hint         | `text-text-muted text-xs`                                   |

---

## Decisions (locked 2026-05-11)

- **Non-dismissible by design** — Orpheus has no useful function without `claude`. We don't let users dismiss the modal and see a broken app.
- **Show install command + docs link, no auto-install** — installing a CLI is the user's responsibility and a confirmation moment we don't try to abstract.
- **MainPage stays mounted behind the backdrop** — gives the user a peek at "this is what you'll get once Claude is installed." Backdrop dims it without unmounting.
- **⌘Q as the escape hatch, surfaced via inline hint** — no in-app Quit button (would muddle the "non-dismissible" intent). The hint educates users who don't already know the macOS convention.
- **Single modal, no wizard / pagination** — this is a binary state (installed or not), not a flow.

---

## Build notes

- New file: `src/renderer/src/components/ClaudeMissingModal.tsx`
- App.tsx structure: always renders `<MainPage existingProjects={...} />` inside `<main>`; when `doctor && !doctor.claudeInstalled`, additionally renders `<ClaudeMissingModal onRecheck={...} />` as a sibling that overlays via `fixed inset-0` positioning.
- The modal must be rendered AFTER MainPage in the JSX tree (so it appears on top in default stacking). Or use a high `z-index` (`z-50` from Tailwind).
- Keep the doctor IPC and the `~/.claude/projects/` scan — both still inform MainPage. The doctor result drives the modal visibility.
- The `setupCompleted` flag and its IPC handlers are deleted (the modal replaces that gate).
