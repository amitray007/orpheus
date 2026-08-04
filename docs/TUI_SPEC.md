# Orpheus TUI + tmux hosting — implementation spec

Status: landed on `feat/opentui-tui`. The list, tmux hosting, the
new-workspace wizard (`n`), and close/archive (`c`/`a`) are implemented; see
the Keymap section for what is and isn't wired.

Renderer note: this shipped on **Ink** (D4). An earlier revision used OpenTUI
(Solid); that tree — referenced as `tui-otui/` in some older comments — was
removed. OpenTUI needs `node:ffi`, which the Electron-hosted Node this CLI
runs under cannot provide.

Goal: one `orpheus tui` surface that runs locally **and** over SSH (Tailscale +
Termius) from a phone, listing projects/workspaces in desktop-sidebar order with
live status, and opening a workspace's terminal into a **tmux**-hosted session
that survives the SSH link dropping.

## Decisions (owner-delegated, locked)

| # | Decision |
| - | -------- |
| D1 | **Universal tmux hosting, staged rollout** (revised from the original "two disjoint hosts, first-opener wins"). Every workspace terminal — desktop AND TUI — is hosted by the same tmux session. The desktop app's native libghostty surface no longer runs `claude` directly on a NEW mount; it runs `tmux attach-session` (`resources/orpheus-attach.sh`) against the same session the TUI attaches to. This is a **staged rollout, not a live migration**: a workspace already mounted natively (from before this change, or from a tmux-missing fallback) is left running exactly as-is — re-parenting a live `claude` into tmux would mean killing and `--resume`ing it, dropping in-flight turns/scrollback. It converts on its next mount from a cold surface (app relaunch, or the workspace closed+reopened), detected via the native addon's own surface-phase query (`getSurfacePhase`), not a special first-mount flag. If tmux is missing or older than tmux 3.1 (the `window-size latest`/`-e` floor), the mount falls back to the native path (`orpheus-claude.sh` directly, exactly as before this change) with a **visible, non-silent notice** — never a silent degrade. `shouldBlockNativeMount` (`src/main/tmuxHost.ts`) survives this rewrite with a **repurposed role**: it is no longer a host-selection gate that blocks a mount and returns a placeholder — it's now a double-launch safety net, feeding the create-vs-attach decision so a stale/downgraded build can never race a second `claude` against a session tmux already owns. Its mirror, `shouldBlockTmuxHost`, protects the opposite direction for `workspace.host` (below), and its scope is deliberately narrow now that tmux hosting is universal: a workspace already backed by a **live tmux session** is always safe to attach to — that's just a second tmux client on a session that already exists, not a second `claude` writer — so `workspace.host` allows it regardless of whether the desktop also has a native surface or claude-registry entry open. The refusal only fires for the genuine double-writer risk: a workspace live *natively* on the desktop with **no** tmux session backing it yet (pre-conversion, or the tmux-missing-fallback case), where a fresh `--resume` here really would race a second writer against the transcript. `shouldBlockTmuxHost` takes a third input (`tmuxSessionExists`, resolved by the caller via `listHostedSessionsCached()`) that short-circuits the refusal to an allow whenever a tmux session already exists; the caller fails safe (treats an unresolvable tmux query as "no session") so an unknown tmux state can never turn into a spurious allow. |
| D2 | **REVISED IN IMPLEMENTATION — see the Keymap section for what shipped.** Original decision: `a` archives **and** kills the tmux session (archive is terminal — an orphaned session is a leak); `x` kills the tmux session **only**, leaving the workspace resumable via `--resume`. What shipped instead: `c` closes (reversible — `workspace.close` destroys the surface and terminates `claude`, and `workspace.reopen` brings it back) and `a` archives (permanent — also removes the git worktree and deletes files). The reversible action moved off `x` and the destructive one off shift-`X` because a shifted/unshifted pair put the two one missed shift apart on a phone keyboard, where shift is a mode switch. Archive is gated behind a two-key confirm (`a` → `d` → enter), not a single press. |
| D3 | TUI is `orpheus tui`. Bare `orpheus` keeps printing help (+ a hint line). The CLI is agent-facing and runs inside ptys, so an isatty heuristic would hang fan-out scripts. |
| D4 | **Ink**, bundled as its own esbuild entry (`dist/tui.cjs`) and `require()`d only inside the `tui` handler, so one-shot commands pay no startup cost. |
| D5 | `/subscribe` gains a **full-snapshot `tree` frame** with a monotonic `revision`, debounced ~50ms. Snapshots (not diffs) so a dropped frame on a flaky link self-heals, and reconnect is free. |
| D6 | First landing: TUI list + live status + Enter-to-open + tmux hosting + docs. Worktree column included (pure rendering). New-session picker and `project add` follow. |

## Environment separation (load-bearing)

Dev, prod, worktree and nightly builds **must never see each other's tmux
sessions**. The tmux socket name is derived from the same function that already
separates the data dirs, `resolveAppName()` in `packages/orpheus-cli/src/paths.ts`:

| App variant | Data dir | tmux socket (`tmux -L …`) |
| ----------- | -------- | ------------------------- |
| `Orpheus` | `~/Library/Application Support/Orpheus` | `orpheus` |
| `Orpheus Dev` | `…/Orpheus Dev` | `orpheus-dev` |
| `Orpheus WT` | `…/Orpheus WT` | `orpheus-wt` |
| `Orpheus Nightly` | `…/Orpheus Nightly` | `orpheus-nightly` |

Main derives the same name from `app.getPath('userData')`'s basename so both
sides agree without a shared import across the process boundary.

## Session naming

`<workspace-slug>-<first 8 of workspace id>` — readable in a bare `tmux ls`,
collision-free, and legal (tmux treats `.` and `:` as target separators, so the
slug strips them).

## Protocol contract

### `workspace.host`

Request `{ id }` → `{ sessionName, socketName, created, alreadyRunning, refused? }`.

Main composes the launch via `composeClaudeLaunch(projectId, workspaceId)` and
creates the session with `tmux -L <socket> new-session -d -s <name> -e KEY=VAL …`.
Every env var goes through `-e` — the tmux **server** is a long-lived daemon and
sessions otherwise inherit the server's environment, not the client's, which
would silently break `ORPHEUS_CLAUDE_FLAGS`, `ORPHEUS_WORKSPACE_ID` and auth env.
The command is `resources/orpheus-claude.sh`, exactly as the ghostty path uses.
`hostWorkspace()` is the **only** code path that ever runs `tmux new-session` —
nothing else, including the desktop mount path, constructs that argv directly,
so the secret-env scrub (`scrubSecretEnvironment`) and duplicate-session race
recovery it owns can never be silently bypassed by a second call site.

`refused: { reason: 'open-on-desktop', message }` is present (with
`created`/`alreadyRunning` both `false`) only when the workspace is currently
live *natively* on the desktop **and** no tmux session exists for it yet — see
`shouldBlockTmuxHost` under D1 above. No tmux session is created or touched in
that case; the message tells the caller the workspace needs to finish
converting to tmux hosting (close it on the desktop, or wait for its next
cold mount) before the TUI can attach. If a tmux session already exists for
the workspace, `workspace.host` always allows the attach — that's the common
case now, since the desktop mounts through the universal-tmux path — and
returns the existing session via `hostWorkspace()`'s own has-session
idempotency (`alreadyRunning: true`).

Before its first tmux operation each app run, main also runs a cached version
check (`tmux -V`, parsed and compared against 3.1 minimum — `new-session -e`
needs 2.1, but `set-option window-size latest` needs 3.1, which is the binding
floor). Sessions main creates also get `mouse on`, `history-limit 50000`, and
`set-titles on` applied via scoped `set-option -t <session>` calls — never
written to the user's own `~/.tmux.conf`.

### `workspace.unhost`

Request `{ id }` → `{ killed }`. Kills the tmux session; workspace untouched.

### `/subscribe` `tree` frame

```jsonc
{
  "type": "tree",
  "revision": 41,
  "projects": [
    {
      "id": "…", "name": "orpheus", "cwd": "~/code/orpheus", "sortOrder": 0,
      "workspaces": [
        {
          "id": "…", "name": "tmux-mobile", "status": "attention",
          "waitingFor": "permission prompt", "parentWorkspaceId": null,
          "worktreeBranch": "feat/tmux-mobile", "sortOrder": 0,
          "tmuxHosted": true, "lastActivityAt": 1234567890,
          "lastTitle": "Understand codebase structure"
        }
      ]
    }
  ]
}
```

Ordering mirrors the desktop sidebar exactly: `sort_order ASC NULLS LAST,
created_at DESC` for both projects and workspaces, so a desktop drag-reorder
shows up in the TUI on the next frame.

## Layout

Designed against 44 cols × 12 rows (iPhone portrait, keyboard up), scaling to 80
and 104. Full visual reference: the published layout artifact.

- Digits are a flat `1..N` across all projects — headers group, never address.
- Attention sorts first, always.
- **Single-width glyphs only, verified against EastAsianWidth.txt.** Meaning
  is carried by colour, never by a glyph alone. No emoji. Note this rule is
  stricter than it first appears: `●` and `○` (named in an earlier draft of
  this spec) are themselves East_Asian_Width=**Ambiguous** and are NOT used —
  they render double-width in a CJK-configured terminal and shift every
  padded line. Ambiguous glyphs are permitted only inside a fixed-width
  `<Box>`, which clips rather than shifts. See `theme.ts`'s header for the
  audited safe/unsafe lists.
- **Default view is `all`, not `active`.** `isActiveStatus()` counts only
  `attention`/`in_progress`, so an `active` default hid every
  `awaiting_input`/`idle` workspace on launch — surprising for a picker whose
  whole job is showing you what exists. `v` still cycles `all`/`active`, and
  the header's `N hidden (v)` hint appears whenever the view is hiding rows.
- View and selection **persist across a detach**: `runTui()`'s loop remounts a
  fresh `<App>` on every picker↔tmux round trip, so both are threaded back in
  rather than resetting to defaults.
- Rendered ages tick locally once a second. The server suppresses
  byte-identical tree frames (correct — an idle picker on a phone should not
  resend unchanged data), so without a local timer an age freezes until some
  unrelated input repaints it.
- Truncate names, never wrap; name column width is a function of `$COLUMNS`.

## Keymap

`enter` open · `j`/`k` move · `n` new · `v` view · `c` close · `a` archive ·
`?` keys · `q` quit

Not implemented: `r` (rename) — needs a server action that isn't exposed yet.

Notes on the keys that carry design decisions:

- **`enter` / `j` / `k`, not `↵` / `↑` / `↓`.** The arrow glyphs are
  East_Asian_Width=Ambiguous and render double-width in a CJK-configured
  terminal, shifting every padded line. Plain ASCII words instead — the same
  rule that governs every glyph in this UI (see `theme.ts`'s header).
- **`c` close, `a` archive — both unshifted, and deliberately not a
  shifted/unshifted pair.** These were `x`/`X` originally. On a phone, shift
  is a keyboard mode switch rather than a chord, which made archive awkward
  to reach and — worse — put the reversible action one missed shift away
  from the permanent one. Two distinct letters mean a slip can't cross that
  boundary. `a` staying unshifted is safe because the protection is the
  multi-step confirm (`a` → `d` → enter), never the shift key.
- **`c` (close) is reversible**: it tears down the surface and terminates
  `claude`, leaving the workspace resumable. **`a` (archive) is permanent**:
  it also removes the git worktree and deletes files.
- **Only `enter`, `n`, `?`, `q` appear in the footer at narrow width** —
  the hint line's budget is ~44 columns and the full set does not fit. Every
  key remains reachable and documented in the `?` overlay.

### New-workspace wizard (`n`)

Three sequential full-width steps — model → mode → confirm — rather than a
modal, which cannot fit the ~38 columns an iPhone-portrait Termius session
gives. Model is two screens (providers, then that provider's models). The
mode step is **skipped entirely** when a project offers only one mode (non-git
cwd, or `.orpheus/config.yml`'s `allowWorktree: false`), since a one-option
screen is pure friction.

There is deliberately **no name-entry step**: `displayTitleFor()` renders
`lastTitle` in preference to `name`, and `lastTitle` is populated from
Claude's own terminal title, so anything typed is overwritten on the first
turn. The wizard sends a generated `<project> HH:MM` instead — no typing, and
still distinguishable in the window before Claude titles it.

A successful create attaches straight into the new workspace's tmux session
rather than returning to the list; creating a workspace is intent to work in
it. It also sends `focus: false`, since `workspace.create` otherwise
foregrounds the **desktop** app — wrong when the create came from a phone.
