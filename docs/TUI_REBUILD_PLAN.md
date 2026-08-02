# TUI rebuild + universal tmux hosting — working plan

Branch: `feat/opentui-tui`. Status doc for work done while the owner is offline.
Supersedes nothing; `docs/TUI_SPEC.md` remains the design spec (its decision
table needs the D1 update noted below).

## The headline: OpenTUI cannot run on our current runtime

**Verified directly, on both runtimes:**

```
node -e "require('node:ffi')"                    → ERR_UNKNOWN_BUILTIN_MODULE  (Node 22.22.3)
ELECTRON_RUN_AS_NODE=1 Electron -e (same)        → ERR_UNKNOWN_BUILTIN_MODULE  (Node 22.22.1)
bun  <opentui createCliRenderer program>         → renders (real escape output)
```

`@opentui/core` loads its native Zig dylib through **`node:ffi`**, a built-in
that first appears in **Node 26.1.0**, behind `--experimental-ffi`, at
Stability 1. Our CLI runs under **Electron 39's embedded Node 22.22.1** via
`ELECTRON_RUN_AS_NODE=1` (`resources/bin/orpheus`). The flag does not exist on
Node 22. This is an engine floor, not a bundling problem — no esbuild trick
fixes it.

**But OpenTUI itself is fine.** It works under Bun. The blocker is purely which
runtime the shim uses.

### Resolution: ship `orpheus tui` under Bun, bundled inside the .app — VERIFIED GO

`tui.mjs` is already a separate bundle loaded by a dynamic `import()` from
`commands/tui.ts`, so **only the `tui` subcommand changes runtime**. Every
other CLI command stays on Electron-as-Node, untouched.

Spike results (all verified, several re-verified independently):

| Check | Result |
| --- | --- |
| esbuild `--bundle --splitting` ESM under Bun | works, no `--external` needed (dylib is `dlopen`'d at runtime, not bundled) |
| Relocation outside `node_modules` | works **only** with the explicit fix below |
| Ad-hoc codesigning (`--force --deep --sign -`) | covers nested `bun` + dylib; existing whole-bundle re-sign in `install-mac.mjs` suffices |
| Cold start to first paint | ~130ms (existing CLI is ~100-250ms) — no regression |
| 44x12 real pty render | **clean** — verified via `tmux new-session -x 44 -y 12` |
| Licences | Bun MIT, OpenTUI MIT — redistribution fine |

**THE TRAP — do not remove this.** Naive relocation *appears* to work on a dev
machine and is a false positive. OpenTUI's asset resolver falls back to a bare
`import("@opentui/core-darwin-arm64")`, and **Bun silently auto-installs
missing bare specifiers from npm** into `~/.bun/install/cache`. Forced offline
with a fresh `$HOME` and an unreachable registry, it fails hard:
`Cannot find module '@opentui/core-darwin-arm64'`. A real user's install hits
exactly that.

Fix (first-class, appears 12x in OpenTUI's shipped JS): ship the dylib
explicitly and point `OTUI_ASSET_ROOT` at its root.

**Ship manifest** (relative to the app bundle):

```
Contents/Resources/cli/tui.mjs                                       (already built)
Contents/Resources/cli/@opentui/core-darwin-arm64/libopentui.dylib   (3.6M)
Contents/Resources/bun                                               (58M)
```

Launch wrapper must export `OTUI_ASSET_ROOT=<the cli dir>` before exec'ing bun.

Size delta: **+61.6M on a 516M app (~12%)**. arm64 only.

### Still owner decisions

- **The +61.6M install-size increase** — a product call.
- **arm64-only** — no x64 mac artifacts found in the release config, but nobody
  confirmed that's intentional. Shipping x64 later needs a second binary + dylib.

### Production gotcha — SOLVED, and load-bearing

OpenTUI captures `console.*` output and paints an overlay over the UI. This is
a real production hazard: one stray `console.warn` from our own code (or any
dependency) would paint over the picker.

Two things that do NOT fully fix it:
- `consoleOptions: { startInDebugMode: false }` — only gates the debug *panel*;
  capture is a separate subsystem (`lib/output.capture.js`), still active.
- `renderer.console.deactivate()` — suppresses the captured text, but a
  `Console ([Copy](ctrl+shift+c))` header STILL paints, stealing a row. On a
  12-row phone screen that is 8% of the viewport lost to a debug artifact.

**The correct fix, verified at 44x12 in a real pty:**

```ts
await createCliRenderer({
  consoleMode: 'disabled',      // ConsoleMode = 'console-overlay' | 'disabled'
  openConsoleOnError: false,    // else an error re-opens the overlay over the UI
})
```

With both set, `console.warn`/`console.error` produce nothing on screen and the
full 12 rows render clean. **Both flags are required** — `openConsoleOnError`
defaults to re-opening the overlay on error, which would surface exactly when
the UI most needs to stay readable.

Corollary: the TUI must route its own diagnostics somewhere other than
`console.*` (a log file, or stderr after the renderer is torn down).

## What proceeds regardless: universal tmux hosting

The tmux layer is **independent of the TUI library**, and on its own it
delivers the phone use case (`tmux attach` from Termius works with no new UI).
So it lands first, as its own unit.

### Correction to "all existing workspaces, right now"

You cannot re-parent a running `claude` into tmux. Migrating a *live* session
means killing it and `--resume`ing — which interrupts in-flight turns and drops
scrollback. That is exactly the failure-case generation the brief said to avoid.

Reconciling both requirements, the correct reading is:

- **New mounts** are tmux-hosted immediately.
- **Existing live sessions** keep their surface and convert on their next
  natural restart — surfaced through the existing `recomputeDirty()` /
  "Restart to apply" chip.
- **tmux missing** → fall back to native hosting with a visible notice
  (macOS does not ship tmux; a hard dependency would brick the app).

Every workspace converges to tmux; nothing is killed underneath the user.

### Architecture (from the audit)

The addon is command-agnostic — `addon.mm` takes a JS-resolved absolute
`opts.command` and execs it. So mounting `tmux attach-session` instead of
`orpheus-claude.sh` is a drop-in; **no native changes needed**.

`terminal:mount` becomes: ensure session exists (idempotent `hostWorkspace`) →
mount ghostty running an attach wrapper. Large env composition moves from
per-mount to per-session-creation.

Status detection is **unaffected** — `sessionState.ts` matches by
`claude_session_id` → `~/.claude/sessions/<pid>.json`, agnostic to process
parentage. `orpheus-claude.sh`'s `unset` of inherited `CLAUDECODE*` vars runs
in the wrapper either way.

Panes are **out of scope** — keyed `pane:<layoutId>:<paneId>`, independent of
workspace session continuity.

### Bugs being fixed first (pre-existing, worsen under universal tmux)

1. **Rename orphans sessions.** `tmuxSessionName()` derives from the workspace
   *name*; renaming makes the computed name miss the running session, so a
   duplicate is created and the original leaks a live `claude` forever.
2. **Archive doesn't guarantee teardown.** D2's "archive kills tmux" is
   composed client-side by the TUI, so the desktop archive action leaks.

### Known regressions to accept or mitigate

- **Scrollback becomes tmux's**, not ghostty's — different search/copy UX. The
  one visible daily change for desktop-only users. Needs sane managed tmux
  defaults (mouse on, large `history-limit`).
- **`window-size latest` goes universal** — any phone attach can resize the
  desktop terminal mid-work. Fine for TUI-opened sessions, questionable as the
  default for every desktop workspace.
- **New SPOF** — a tmux server crash takes down every workspace at once, vs
  independent surfaces today. The mount path must handle "session vanished"
  gracefully (offer resume), not error.
- **Secret exposure window** — auth env goes in via `tmux -e`; `hostWorkspace`
  scrubs it immediately, but the gap is nonzero, and `tmux show-environment` is
  a query surface the ghostty path never had. Same-user only. Documented
  residual risk.

### Spec drift to fix in the same commit

`TUI_SPEC.md` D1 ("two disjoint hosts, first-opener wins") is **reversed** by
universal tmux. `tmuxHost.ts`'s `shouldBlockNativeMount` guard is built on it.
Keep the guard as a universal safety net (it prevents a double-launch on
downgrade) but update the decision table — a spec contradicting the code is
worse than no spec.

## Open questions for the owner

1. **Runtime**: Bun-in-bundle, the koffi fork, or wait? (blocks the TUI rebuild)
2. **Rename semantics**: `rename-session` on rename, or key sessions by id only?
3. **"Restart to apply"** now means kill+recreate the tmux session (ends any
   attached phone client's session). Confirmation step, or silent?
4. **`claude` exits inside a session** — shell fallback with a UI affordance, or
   auto-respawn? (auto-respawn can mask a crash loop)
5. **tmux missing** — hard requirement (cask can `depends_on formula: "tmux"`)
   or the graceful fallback above? A hard requirement changes install
   requirements for every user, not just remote-access users.
6. **Mouse mode inside tmux** — not configured today; needed for desktop parity?
