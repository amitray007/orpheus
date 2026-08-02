# Orpheus TUI on OpenTUI — design spec

Implementation guide for the `orpheus tui` rebuild. Patterns here are taken
from **OpenCode's own source** (`packages/tui/src/`), the largest real-world
OpenTUI application, not from docs. Cited paths are relative to that repo.

Supersedes the Ink implementation (`packages/orpheus-cli/src/tui/`), which
remains until this replaces it. Layout/keymap contract in `docs/TUI_SPEC.md`
still applies except where noted.

## Non-negotiables (verified the hard way)

### 1. Console overlay must be disabled

OpenTUI captures `console.*` and paints an overlay over the UI. One stray
`console.warn` from us or any dependency would paint over the picker.

```ts
await createCliRenderer({
  consoleMode: 'disabled',      // 'console-overlay' | 'disabled'
  openConsoleOnError: false,    // else an error re-opens it over the UI
})
```

**Both required.** `consoleOptions.startInDebugMode: false` only gates the
debug *panel* — capture is a separate subsystem. `renderer.console.deactivate()`
still leaves a `Console ([Copy](ctrl+shift+c))` header stealing a row (8% of a
12-row phone screen). Verified at 44x12 in a real pty.

Corollary: TUI diagnostics never go to `console.*`. Write to a file, or to
stderr only after `renderer.destroy()`.

### 2. Never `process.exit()` while the renderer is live

It skips terminal cleanup and leaves the terminal in alt-screen/raw mode. Call
`renderer.destroy()` and let the process end naturally.

### 3. State is NEVER carried by colour alone

This is the Termius lesson. OpenCode's Termius rendering complaint
(`opencode#16595`) traces to `tint(bg, fg, 0.25)` blends — colours differing
from their base by ~25%, which collapse when a client quantizes the palette.
The issue was auto-closed by a stale bot; no maintainer diagnosed it, so treat
it as a design constraint, not an OpenTUI defect.

OpenCode's own `Option` component already applies the fix — colour AND a text
attribute together (`dialog-select.tsx:766-768`):

```tsx
<text fg={text()} attributes={props.active ? TextAttributes.BOLD : undefined}>
```

Every state distinction must survive both colour loss and quantization:
pair colour with **bold**, a **gutter glyph**, or a **background block**.
Avoid `post/effects` and `post/filters` (shadow/blur) entirely.

## Reconciler: Solid

OpenCode uses `@opentui/solid` (`app.tsx:1`). Reasons to match it:

- It is the reference implementation — every pattern below is directly portable.
- Fine-grained reactivity suits our workload: many workspaces, per-row status
  ticking. A status change re-runs only what reads that signal, with no
  `React.memo` discipline to hand-maintain.

React is supported and symmetric if ever needed, but costs re-render management
we get free with Solid.

## Root layout — the responsive core

From `app.tsx:1089-1124`. This is what makes it work at any size:

```tsx
const dimensions = useTerminalDimensions()

<box width={dimensions().width} height={dimensions().height} flexDirection="column">
  <box flexShrink={0}>{/* header */}</box>
  <box flexGrow={1} minHeight={0} flexDirection="column">{/* list */}</box>
  <box flexShrink={0}>{/* footer */}</box>
</box>
```

`minHeight={0}` on the growing body is **load-bearing** — without it flex
children refuse to shrink below content size and the layout overflows.

**Flex first, breakpoints only at leaves.** OpenCode has no global breakpoint
framework; it reflows via flexbox and applies explicit numeric caps only where
needed (e.g. list height capped at `Math.floor(terminalHeight / 2) - 6`, never
claiming more than half the screen). Our 44/80/104 tiers should become
flex behaviour plus a few leaf conditionals, not a parallel layout system.

## The list — copy `DialogSelect`'s shape

`ui/dialog-select.tsx` (730 lines) is the generic list used for every
list-shaped surface in OpenCode. Option shape:

```
{ title, value, category?, footer?, details?[], gutter?: () => JSX, muted?, disabled? }
```

- `category` groups rows under a header → our **project** grouping.
- `gutter` is a per-row leading slot → our **status dot / spinner**.
- Three-way row state, not a binary: `active` (keyboard focus) vs `current`
  (the open workspace) vs neutral. Each gets a distinct treatment. Our Ink
  version conflated these; don't repeat that.
- Truncation is **manual** — nothing auto-ellipsizes. OpenCode has
  `Locale.truncate` / `truncateLeft` / `truncateMiddle` with explicit width
  budgets. Build one shared helper on day one; `string-width` is already a
  dependency of `@opentui/core` for wide-char correctness.
- Scroll-to-selection is hand-rolled on `scrollbox` (`scrollBy`/`scrollTo` from
  computed row offsets) — `scrollChildIntoView` is NOT what production uses.
- Keyboard drives selection; mouse is a secondary path into the same signal,
  gated by an `input: 'keyboard' | 'mouse'` mode flag so hover doesn't fight
  arrows. **Keyboard must work standalone** — SSH mouse reporting is unreliable.

## Project → workspace nesting

From `feature-plugins/system/diff-viewer-file-tree.tsx`: flatten the tree to
rows carrying `{ depth, hasLaterSibling }`, then draw `├─ ` / `└─ ` / `│  `
prefixes yourself. Literal nested JSX does not produce correct branch lines.
Expand/collapse via a `Set<id>` of expanded nodes.

Our existing `flattenTree` in `layout.ts` already does depth flattening — the
logic is portable even though the rendering is not.

## Theming

Two-level indirection: `defs` (raw palette steps) → `theme` (semantic roles:
`primary`, `text`, `textMuted`, `background`, `backgroundPanel`, `border`),
each with `dark`/`light` values. OpenCode ships JSON themes and additionally
**auto-generates a "system" theme** from the terminal's real palette via
`renderer.getPalette()`, with `renderer.themeMode` reporting dark/light.

Adopt the same shape. Feature-detect rather than assume: `renderer.getPalette()`,
`renderer.themeMode`, `renderer.isOsc52Supported()` for clipboard.

## Performance

- Native Zig renderer with **diff-based repainting** — only changed cells are
  sent. This is what keeps SSH bandwidth low.
- **Not a continuous redraw**: `requestRender()`-driven dirty loop, default
  `targetFps: 30`. Idle screens send nothing.
- **No virtualization primitive.** `scrollbox` renders all children and clips at
  draw time. Fine for dozens-to-low-hundreds of rows; hand-roll windowing only
  if we ever exceed that.
- Socket frames arrive ~50ms debounced. Buffer in a ref/signal and let Solid's
  fine-grained updates handle the rest — do not rebuild the tree per frame.

## Avoid list (SSH / Termius safety)

- `post/effects`, `post/filters` — shadow/blur compositing.
- Colour-only state distinction (see non-negotiable #3).
- Assuming truecolor. OpenTUI emits 24-bit and degrades, but subtle deltas do
  not survive quantization.
- Depending on mouse, OSC 52 clipboard, Kitty graphics/keyboard protocol —
  all progressive enhancement, never critical path.
- `@opentui/ssh` — that is for writing an SSH *server* that hosts a TUI as the
  shell. Wrong tool: we run as a normal command inside an ordinary SSH session.

## Version discipline

`@opentui/*` is pre-1.0 with a stated v1.0 plan to move the renderable tree
into native code — a large internal rewrite. **Pin exact versions** (not `^`)
and treat every upgrade as a mini-migration.
