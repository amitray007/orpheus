# React Overlay Layer above the Terminal (Overlay WebContentsView)

> **AMENDMENT (2026-07-02, Phase A live verification) — host corrected to a
> child window.** Runtime ground truth (NSView stack dump in the dev build)
> invalidated this spec's central mechanism: Chromium composites ALL of a
> window's web content through a single topmost `ViewsCompositorSuperview`
> NSView; the per-`WebContentsView` `WebContentsViewCocoa` children are event
> shells, not pixel surfaces. Sibling NSView ordering therefore CANNOT place
> web pixels above the terminal in the same window — the overlay view rendered
> into the shared compositor and stayed visually under the opaque-on-top
> terminal no matter its NSView index (and native re-adds of Chromium's view
> broke its compositing outright). The corrected host: the SAME overlay
> `WebContentsView`/renderer/bridge, but in a frameless transparent CHILD
> `BrowserWindow` (`parent: mainWindow`) — its own compositor, always above
> the parent, moves with it; `showInactive()` for card/tooltip classes (zero
> key-window churn), `show()+focus()` only for `takesFocus` modals;
> `setIgnoreMouseEvents(true)` for tooltip-class. The terminal keeps
> production ordering (topmost sibling, above the compositor view) and is
> structurally un-occludable. Everything else in this spec (descriptors,
> generations, handshake, exclusivity, focus save/restore, migration phases)
> carries over unchanged. Sections below describing same-window
> `addChildView` stacking and the addon ordering invariant are superseded by
> this amendment.

**Date:** 2026-07-02
**Status:** Approved design, pre-implementation (amended: child-window host)
**Owner branch:** `worktree-overlay-webcontentsview` (worktree off `staging`)

## Problem

The libghostty terminal is an opaque native `NSView` mounted as the topmost sibling
of the Electron `contentView` (`packages/ghostty-surface/addon.mm` — attach via
`addSubview:positioned:NSWindowAbove relativeTo:nil`). Any React/DOM content that
overlaps the terminal rect is fully occluded. The current answer is a native
AppKit popover/modal chassis drawn by the addon (`nativePopover.ts` +
`ShowPopover`/`ShowConfirmModal` paths in `addon.mm`), which works but requires
every new overlay to be hand-built in Objective-C. Richer overlay UI (command
palettes, forms, diff views) is impractical natively, and several React surfaces
are still silently occluded today (footer `ActionChip` popovers, the one-time
notice banner).

### Approaches already tried and abandoned (do not repeat)

| Approach | Commits | Why it died |
| --- | --- | --- |
| Terminal at bottom + transparent window | `314659e`, `2adc15d`, `90933c9`, `c236e50`, `64d69a1` | Full-frame alpha-blend cost, desktop bleed-through (needed backstop), hit-test misrouting froze the terminal |
| Dynamic z-swap while overlay open (`setOverlay`) | `5dbec5e` | Per-popover discipline, blanking, focus-steal freezes |
| Freeze watchdog | `47a1aff`…`d0bce07` | Treated the symptom; retired by `220f516` |
| Opaque-on-top + native chassis | `9988ba8`, `26f31a7`, `1eefc4a` | Works (current); but overlay UI is ObjC-only |

A second web layer (`WebContentsView`) was **never** tried (verified via
`git log -S` for `BrowserView`/`addChildView`/`WebContentsView`).

## Constraints (from the user)

1. Terminal must **stay live and visible** under any overlay — never hidden,
   never frozen, never blanked.
2. Lowest practical latency; overlays must feel instant.
3. No consistency issues, no terminal/app freezes or crashes — the freeze class
   of bugs from past attempts must be structurally impossible, not mitigated.
4. Goal: React DX for all overlays; richer overlay UI is coming soon.

## Decision

Add **one** pre-warmed, transparent `WebContentsView` (the **overlay layer**) to
the existing `BrowserWindow.contentView` at startup. Never move the terminal or
the main web layer. Final NSView stack, bottom→top:

```text
backstop (index 0)
→ main WebContents (all existing React UI)
→ terminal NSView (live, opaque, untouched; its loading-overlay child renders with it)
→ overlay WebContentsView (transparent, hidden when idle)
→ native chassis popovers/modals while they still exist (added NSWindowAbove at show time)
```

All required Electron APIs are confirmed present in Electron 39 (`electron.d.ts`):
`BrowserWindow extends BaseWindow` (so `win.contentView` exists),
`View.addChildView(view, index?)`, `View.setBounds`, `View.setVisible`,
`View.removeChildView`, `View.setBackgroundColor` (accepts alpha),
`webPreferences.transparent`.

## Architecture

### Stacking invariant (addon-owned, single writer)

Electron does not expose a native handle for a `WebContentsView`, so the addon
identifies the overlay NSView by **registration diff**: a new NAPI pair —
main calls `beginOverlayRegistration()` (addon snapshots
`contentView.subviews`), main calls `contentView.addChildView(overlayView)`,
main calls `commitOverlayRegistration()` (addon diffs subviews; exactly one new
subview = the overlay; store a weak reference). One-time, at `ready-to-show`,
right after `installBackstop`.

Registration failure is observable, never silent: `commitOverlayRegistration()`
returns a success flag (diff must be exactly one new subview), and the addon
exposes an `isOverlayRegistered()` query. On registration failure — or if the
weak reference later dies — `overlayLayer.ts` marks itself unavailable and
`overlay:show` rejects immediately; callers keep routing to the still-present
chassis path. The overlay view is never made visible (and never focused) while
the ordering invariant is unenforceable — otherwise a modal could sit invisible
beneath the terminal while holding keyboard focus.

From then on the addon enforces one invariant in one place: **on every terminal
attach/re-attach** (`reconcileSurface` / mount paths), the terminal view is
inserted `positioned:NSWindowBelow relativeTo:overlayView`. If the overlay
reference is nil/gone, fall back to today's `NSWindowAbove relativeTo:nil`.
Native popover/modal chassis views (which remain during migration) continue to
be added `NSWindowAbove relativeTo:nil`, i.e. above the overlay layer — this
preserves chassis behavior until each surface migrates.

### Main-process owner: `src/main/overlayLayer.ts`

Single owner of the overlay layer (mirrors the `nativePopover.ts` flow pattern):

- Creates the `WebContentsView` at `ready-to-show`:
  `webPreferences: { preload: overlayPreload, transparent: true, backgroundThrottling: false }`,
  plus `view.setBackgroundColor('#00000000')`; loads the overlay renderer entry;
  starts hidden (`setVisible(false)`); registers with the addon (above).
  `backgroundThrottling: false` is load-bearing, not an optimization: Chromium
  pauses rAF for hidden web contents, so without it the double-rAF paint ack
  below never fires and every open stalls. The main window already sets the
  same flag (`src/main/index.ts`) for the same reason.
- API surface (exposed to the main renderer via IPC, like the popover IPC today):
  - `overlay:show(descriptor)` — see lifecycle below
  - `overlay:update(id, props)`
  - `overlay:hide(id)` — hides the view, restores the first responder saved at
    show time (see Close below)
  - `overlay:event` (overlay renderer → main → forwarded to main renderer)
- Crash recovery: on `render-process-gone` of the overlay webContents —
  `setVisible(false)`, notify the main renderer (so it can resolve/reject any
  pending overlay promise), `webContents.reload()`. Terminal and main app are
  unaffected by construction.
- Window resize: full-window overlays get `setBounds` from the existing window
  resize listener; anchored popovers are dismissed on resize (matches current
  chassis behavior).

### Overlay renderer

- Second HTML entry in the same electron-vite build: `src/renderer/overlay.html`
  → `src/renderer/src/overlay/main.tsx`. Shares Tailwind v4 config, tokens,
  Geist fonts, and presentational components with the main app.
- Small React root that renders by descriptor `kind` (a registry:
  `confirm`, `card`, … extensible).
- Its own thin preload (`src/preload/overlay.ts` → `window.overlayApi`):
  `onShow`, `onUpdate`, `sendEvent`, `ackPainted`.
- Overlay components are self-contained: serializable props in, events out.
  No direct access to the main app's React context/zustand stores (same
  contract `nativePopover.ts` imposes today).

### Shared types

Descriptors live in `src/shared/types.ts`:

```ts
type OverlayDescriptor = {
  id: string
  kind: string                    // registry key in the overlay renderer
  placement:
    | { mode: 'anchored'; anchorRect: Rect; preferredSide?: 'top'|'bottom'|'left'|'right' }
    | { mode: 'centered' }        // full-window bounds + scrim
  props: unknown                  // serializable, kind-specific
  acceptsClicks: boolean          // false = display-only (tooltips)
  takesFocus: boolean             // true ONLY for confirm/palette-class overlays
}
```

`acceptsClicks` and `takesFocus` are deliberately separate policies, mirroring
the chassis: today only `confirm` modals become first responder, while
hover/details/project cards are clickable (PR chips, buttons) WITHOUT ever
stealing keyboard focus from the terminal. Collapsing both into one flag would
regress hover cards into keystroke thieves.

## Data flow

> Amendment (2026-07-02, planning research): Electron #44590 — a view hidden via
> `setVisible(false)` (or occluded) reports `visibilityState: 'hidden'` and can
> read `innerWidth === 0` even with `backgroundThrottling: false`, which breaks
> paint-while-hidden. The implementation plan therefore keeps the view
> permanently visible and hides by parking bounds at zero: open becomes
> `setBounds(target)` → render → ack → CSS fade-in. Transparent pixels mean
> nothing flashes. See the plan's Key Technical Decisions for the verified
> recipe and fallbacks; where this section says `setVisible`, read
> bounds-parking.

### Open (paint-then-show handshake — no flash of empty/stale content)

1. Main renderer requests an overlay (like `showConfirmModal` today) →
   `overlay:show(descriptor)`.
2. Main process forwards the descriptor to the overlay renderer.
3. Overlay renderer renders the component, waits for paint (double-rAF), then
   sends `ackPainted`. The overlay root wraps every `kind` in an error boundary
   that still acks (rendering a minimal error card) — a component that throws
   must not strand the caller.
4. Main process computes bounds (anchored: card rect + shadow margin, clamped
   to window; centered: full window), calls `setBounds`, then
   `setVisible(true)`. It saves the current first responder, and only if
   `takesFocus` calls `overlayContents.focus()` — hover/details/project cards
   never take keyboard focus (the chassis's actual policy).

`overlay:show` is total: main arms a per-show timeout (~500 ms); on expiry (or
a show racing a post-crash reload) the promise rejects and the view stays
hidden — mirroring `showConfirmModal`'s existing resolve-as-cancel-on-failure
contract. Entrance/exit match the chassis's fades (~120 ms in, ~100 ms out) via
CSS transitions in the overlay renderer; the hide path plays the exit
transition (renderer signals `exited`, bounded by a 150 ms cap) before
`setVisible(false)`.

Total cost: one IPC round trip + one paint (~1–2 frames). The view and its
renderer process are pre-warmed at startup; nothing is spawned at open time.

Content growth after first paint is never clipped: the overlay renderer
attaches a `ResizeObserver` to the card root and reports size changes over the
event channel; main re-clamps and calls `setBounds` on every report. This is
required from day one: the details popover already loads cost/context/git info
asynchronously (today's chassis patches it in via `updateDetailsPopover`), and
phase-3 rich UI (autocomplete, expanding sections) grows after first paint.

### Bounds policy = input-routing policy (no pass-through hacks)

- **Anchored popovers/cards/tooltips:** view bounds fitted to the card rect.
  Outside the rect, clicks hit the terminal/main UI natively.
- **Modals/sheets/palettes:** full-window bounds; the DOM scrim intentionally
  captures all input.
- **One interactive overlay at a time** (the chassis's exclusivity rule, now
  structural). Toasts/banners stay in the main web layer in non-terminal regions.
  During migration (phases 2–3) exclusivity must span BOTH systems: a single
  token owned by main (`overlayLayer.ts`), consulted by `overlay:show` AND the
  existing `terminal:showPopover` IPC handler — while an interactive overlay is
  visible, main rejects native popover show requests (and vice versa). This
  replaces the renderer-side `isModalOpen()` guard, which only tracks native
  modals and would let a native hover card open on top of a React confirm.
- Outside-click dismissal for anchored overlays is driven from main, because
  clicks landing on the terminal NSView never reach the main renderer's DOM
  (the terminal sits above the main web layer): the addon emits an
  outside-pointer-down callback for terminal-region mousedowns while an
  anchored overlay is visible, and main calls `overlay:hide`; clicks in the
  main web layer dismiss via a renderer `pointerdown` listener that also calls
  `overlay:hide`. (Note: today's chassis dismisses via native tracking areas
  and backdrop mousedown in `addon.mm`, not renderer outside-click detection —
  there is no existing renderer mechanism to reuse.)
- Hover-card lifecycle bridges the two web contexts explicitly: the overlay
  card reports `mouseenter`/`mouseleave` over the event channel, and the main
  renderer cancels/re-arms its close timer accordingly — mirroring the native
  card's `pointerInCard` tracking-area bridge (which is what lets the pointer
  cross the gap from a sidebar row into the card today). Chassis timings are
  preserved: 120 ms open, 80 ms close.

### Close

Exit transition plays (150 ms cap) → `setVisible(false)` → main restores the
first responder **saved at show time** — not unconditionally the terminal —
falling back to `terminal:focus` only when the saved responder is gone. This is
the chassis's actual save/restore pattern (`addon.mm`
`g_modalPreviousFirstResponder`): restoring the terminal unconditionally would
yank focus away from a main-layer input the user was typing in when the
overlay opened.

Escape handling is owned by the overlay renderer for every `kind`: a global
`keydown` listener in the overlay root maps Escape to the kind's cancel/dismiss
event (sent over the event channel like any other event), so the behavior is
uniform across confirm/card/palette rather than re-implemented per component.
This applies only when the overlay `takesFocus`; for non-focused overlays the
main renderer keeps its existing Escape handling.

## Why the historical failure modes do not apply

- **Freeze/focus-steal class:** caused by moving the terminal or main web layer
  and by focus leaving the terminal without restore. Here neither layer ever
  moves; focus restore reuses the shipped pattern.
- **Alpha-blend cost:** the main window stays opaque; the overlay view is hidden
  when idle (negligible cost — a static hidden DOM requests no frames even with
  throttling disabled) and popover-sized when small.
- **Desktop bleed:** impossible — backstop and opaque window unchanged.
- **Input misrouting:** no hit-test swizzles; routing is pure NSView geometry.
  The terminal's `nonWebContentView` hook is unaffected (it only applies to
  events that hit the ghostty view).
- **Crash isolation:** overlay renderer death cannot take down the terminal
  (separate process, separate view); recovery is hide + reload.

## Known residual risks (eyes open)

- **Docked DevTools (dev only)** may stack oddly with native subviews; use
  detached DevTools for the overlay renderer.
- **Memory:** one extra renderer process, ~60–80 MB.
- **Electron view-tree interference:** Electron only reorders its own child
  views on explicit `addChildView` calls; we add the overlay once. The addon
  re-asserts terminal ordering on every attach as belt-and-suspenders.
- **IME/emoji/input methods** inside overlay inputs work normally (real
  in-window web view) — this is precisely what the rejected OSR approach would
  have broken.

## Alternatives considered and rejected

- **Evolve the native chassis (declarative native UI DSL):** zero new
  architecture risk and lowest latency, but never React; contradicts the goal.
  The chassis stays only as a migration bridge.
- **OSR texture blit** (offscreen React composited by the addon + synthetic
  input forwarding): per-pixel click-through, but synthetic input forwarding
  (IME, scroll momentum, cursor shapes, drag) is a consistency-bug farm.
  Rejected on the "no consistency issues" constraint.
- **Same-window `WebContentsView` sibling (original decision, superseded by
  the 2026-07-02 amendment):** all of a window's web content composites
  through one shared topmost NSView, so a sibling `WebContentsView` cannot
  place pixels above the opaque terminal regardless of NSView ordering. The
  amended host — a frameless transparent **child `BrowserWindow`**
  (`parent: mainWindow`) — has its own compositor, so it renders above the
  terminal unconditionally; `showInactive()` avoids the key-window flips/focus
  flicker of a normal child window for card/tooltip classes, with
  `show()+focus()` reserved for `takesFocus` modals.
- **Snapshot-the-terminal-then-overlay:** violates the "terminal must stay
  live" constraint.

## Migration plan (each phase independently shippable)

1. **Infra:** overlay view + addon registration/ordering + typed bridge + a
   dev-menu test overlay. Verify: live terminal visibly updating under a React
   scrim, focus restore on close, open latency, crash recovery.
2. **Confirm modals → React:** the four `showConfirmModal` call sites in
   `Dashboard.tsx` + the worktree error card in `WorkspaceView.tsx`.
3. **Popovers → React:** hover/details/project cards; fix the currently-broken
   surfaces (footer `ActionChip` popovers, notice banner); rich new UI
   (palettes, sheets) unblocked here.
4. **Delete the ObjC chassis UI** (~1,500 lines: popover/modal drawing, font +
   icon registration) — keep the loading overlay and the ordering primitive.

Phases 2–4 each require parity verification before the corresponding native
path is removed. Per repo rules (CLAUDE.md), implementation is delegated to
Sonnet subagents; the orchestrator reviews and integrates.

## Testing / verification (manual — no test runner in this repo)

Per phase 1 at minimum:

- Terminal keeps streaming output while an overlay is visible (live check).
- Open/close 50× rapid-fire: no freeze, no blanking, no focus loss (typing
  resumes in terminal immediately after close).
- Workspace switch while an overlay is open; window resize while open;
  fullscreen enter/exit while open.
- Kill the overlay renderer process manually → terminal unaffected, overlay
  recovers on next show.
- `pgrep` sanity + `bun run typecheck` + `bun run lint` before each commit.
