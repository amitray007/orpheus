# Overlays above a native NSView in Electron (macOS): what actually works

Learnings from building the React overlay layer above the libghostty terminal
(2026-07-02, Phase A of `docs/plans/2026-07-02-001-feat-overlay-webcontentsview-plan.md`,
spec `.claude/specs/2026-07-02-overlay-webcontentsview-design.md`). Several of
these were discovered at runtime and contradict what Electron's API docs imply.
Read this before touching overlay hosting, terminal z-order, or anything that
adds views to the main window.

## The one that invalidated the original design

**A same-window `WebContentsView` can NEVER render above a native sibling
NSView on macOS.** Chromium composites ALL of a window's web content through a
single full-window `ViewsCompositorSuperview` NSView. The per-view
`WebContentsViewCocoa` children you see in `contentView.subviews` are event
shells — they carry hit-testing, not pixels. Reordering them (via
`addChildView` re-adds or native `addSubview:positioned:`) changes nothing
about what's on screen. The docs' "addChildView re-add raises the view" is
about Electron's internal views tree, not native compositing against foreign
NSViews. Verified with a live NSView stack dump: overlay content painted, acks
flowed, `document.visibilityState === 'visible'` — and nothing appeared,
because its pixels lived inside the shared compositor layer under the opaque
terminal.

Corollary: the production terminal architecture works precisely because the
terminal NSView is attached `NSWindowAbove relativeTo:nil` — above the ONE
compositor view — so it beats all web content at once. Any design that needs
web pixels above the terminal in the same window is dead on arrival.

## The recipe that works: a child `BrowserWindow`

A separate window gets its own compositor, so it genuinely renders above the
parent (and the terminal). What we ship (`src/main/overlayLayer.ts`):

- `new BrowserWindow({ parent: mainWindow, show: false, frame: false,
  transparent: true, hasShadow: false, resizable/movable/minimizable/
  maximizable/fullscreenable: false, focusable: true, skipTaskbar: true,
  roundedCorners: false, backgroundColor: '#00000000', webPreferences:
  { preload: overlay preload, sandbox: false, backgroundThrottling: false } })`
- Attached via `parent:` it stays above the main window and moves with it at
  the window-server level — no manual move syncing.
- `showInactive()` for card/tooltip-class overlays — zero key-window churn,
  the terminal keeps keyboard focus. `show()` + `webContents.focus()` only for
  `takesFocus` (modal-class) overlays.
- `setIgnoreMouseEvents(true)` for tooltip-class — real click-through, better
  than any geometry trick.
- Bounds are SCREEN coordinates (offset by `win.getContentBounds()` origin;
  multiply renderer CSS rects by `webContents.getZoomFactor()`).
- Show order: `setBounds` → `setIgnoreMouseEvents` → `show()/showInactive()`
  → THEN send the descriptor to the overlay renderer → double-rAF →
  `ackPainted` → CSS fade-in. Paint into a VISIBLE window: a hidden/occluded
  webContents can report `visibilityState: 'hidden'` and `innerWidth === 0`
  even with `backgroundThrottling: false` (Electron #44590), so never gate the
  handshake on a hidden paint. A transparent empty window is invisible — this
  ordering has no flash.
- Known limitation: child windows don't reliably follow the parent into a
  macOS fullscreen Space — overlays force-dismiss on enter/leave-full-screen.

Anchored (popover-style) placement: the child window is sized to the CARD, not
the anchor. The overlay renderer wraps the card in a `width/height:
max-content` element and reports its natural size via ResizeObserver →
`reportSize` IPC; main starts from a generous default (440×380, transparent,
invisible), then re-runs full placement (preferred side → flip if it doesn't
fit → clamp inside parent content bounds, 6px gap) with the measured size.
Never size the window to the anchor rect — the card clips.

## Things that silently break (do not repeat)

1. **Never `removeFromSuperview` + `addSubview` a Chromium-managed NSView from
   native code.** Compositing detaches silently: the renderer keeps painting
   and acking, the view is "topmost", nothing shows (Electron #44652 class).
   If you must reorder around Chromium views, move YOUR OWN views instead.
2. **Chromium restacks `contentView` children whenever it likes** (boot, show,
   focus — not just DevTools/fullscreen). Foreign views (backstop, terminal)
   get shuffled; our opaque backstop once landed ABOVE the terminal = "black
   terminal". The addon self-heals in `reassertOverlayOrder()` (called from
   `reconcileSurface`'s already-attached path, i.e. on every nav/kick/wake):
   re-sink `OrpheusBackstopView` to index 0, re-raise any terminal that isn't
   above the topmost `ViewsCompositorSuperview`. It moves ONLY our views and
   preserves the first responder across the move.
3. **`ready-to-show` refires** when `backgroundThrottling: false` is set (the
   main window sets it). Anything wired there must be idempotent per window —
   a re-entrant init that tears down and recreates on every fire self-sustains
   into a resource-spawning loop (each new view's first paint refires the
   event). This is why `installBackstop` is `dispatch_once` and
   `initOverlayLayer` has a same-window guard.
4. **`View.setBackgroundColor` alpha is leading** (`#AARRGGBB`), and a
   `WebContentsView`/window needs `'#00000000'` explicitly — the default
   background is opaque by design (Electron #44914). Re-apply after any
   `webContents.reload()` (crash recovery).

## Process learnings (how the root cause was actually found)

- `ELECTRON_ENABLE_LOGGING=1` + launching the binary directly captures main
  process + renderer console + addon NSLog in one stream.
- `--remote-debugging-port` + CDP `Runtime.evaluate` lets the orchestrating
  agent drive `window.api.*` and inspect the overlay renderer without a human
  clicking — both web layers appear as page targets.
- When z-order misbehaves, stop reasoning from API docs and dump
  `contentView.subviews` (class/pointer/frame per index) from the addon. The
  single dump that showed `ViewsCompositorSuperview` at the top answered what
  three rounds of doc-grounded fixes could not.
- Multi-agent doc review + Electron-issues research caught many real design
  flaws pre-code (hidden-view rAF, attach-once, focus split), but the
  compositor topology was only discoverable by running the thing. Budget a
  live spike for any assumption the docs can't confirm.

## Where the pieces live

- Host + state machine + exclusivity token: `src/main/overlayLayer.ts`
- Descriptor/bridge types: `src/shared/types.ts` (Overlay section);
  preloads `src/preload/index.ts` (`window.api.overlay`),
  `src/preload/overlay.ts` (`window.overlayApi`)
- Overlay renderer root: `src/renderer/src/overlay/` (registry, error
  boundary that always acks, fades, ResizeObserver reporting)
- Addon self-heal + focus primitives: `packages/ghostty-surface/addon.mm`
  (`reassertOverlayOrder`, `setOverlayFocusSuppressed`, saved-responder pair —
  the registration-diff primitives are retired but retained)
- Dev harness: Cmd+Shift+Alt+O (`src/renderer/src/lib/overlayDevTest.ts`,
  dev-gated), kind `devTest` in the overlay registry
