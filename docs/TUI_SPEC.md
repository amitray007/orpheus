# Orpheus TUI + tmux hosting — implementation spec

Status: in progress on `claude/tmux-tailscale-streaming-w1x5s3`.

Goal: one `orpheus tui` surface that runs locally **and** over SSH (Tailscale +
Termius) from a phone, listing projects/workspaces in desktop-sidebar order with
live status, and opening a workspace's terminal into a **tmux**-hosted session
that survives the SSH link dropping.

## Decisions (owner-delegated, locked)

| # | Decision |
| - | -------- |
| D1 | **Universal tmux hosting, staged rollout** (revised from the original "two disjoint hosts, first-opener wins"). Every workspace terminal — desktop AND TUI — is hosted by the same tmux session. The desktop app's native libghostty surface no longer runs `claude` directly on a NEW mount; it runs `tmux attach-session` (`resources/orpheus-attach.sh`) against the same session the TUI attaches to. This is a **staged rollout, not a live migration**: a workspace already mounted natively (from before this change, or from a tmux-missing fallback) is left running exactly as-is — re-parenting a live `claude` into tmux would mean killing and `--resume`ing it, dropping in-flight turns/scrollback. It converts on its next mount from a cold surface (app relaunch, or the workspace closed+reopened), detected via the native addon's own surface-phase query (`getSurfacePhase`), not a special first-mount flag. If tmux is missing or older than tmux 3.1 (the `window-size latest`/`-e` floor), the mount falls back to the native path (`orpheus-claude.sh` directly, exactly as before this change) with a **visible, non-silent notice** — never a silent degrade. `shouldBlockNativeMount` (`src/main/tmuxHost.ts`) survives this rewrite with a **repurposed role**: it is no longer a host-selection gate that blocks a mount and returns a placeholder — it's now a double-launch safety net, feeding the create-vs-attach decision so a stale/downgraded build can never race a second `claude` against a session tmux already owns. Its mirror, `shouldBlockTmuxHost`, protects the opposite direction for `workspace.host` (below), and its scope is deliberately narrow now that tmux hosting is universal: a workspace already backed by a **live tmux session** is always safe to attach to — that's just a second tmux client on a session that already exists, not a second `claude` writer — so `workspace.host` allows it regardless of whether the desktop also has a native surface or claude-registry entry open. The refusal only fires for the genuine double-writer risk: a workspace live *natively* on the desktop with **no** tmux session backing it yet (pre-conversion, or the tmux-missing-fallback case), where a fresh `--resume` here really would race a second writer against the transcript. `shouldBlockTmuxHost` takes a third input (`tmuxSessionExists`, resolved by the caller via `listHostedSessionsCached()`) that short-circuits the refusal to an allow whenever a tmux session already exists; the caller fails safe (treats an unresolvable tmux query as "no session") so an unknown tmux state can never turn into a spurious allow. |
| D2 | `a` archives **and** kills the tmux session (archive is terminal — an orphaned session is a leak). `x` kills the tmux session **only**, leaving the workspace resumable via `--resume`. Both confirm inline. |
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
          "tmuxHosted": true, "lastActivityAt": 1234567890
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
- Single-width glyphs only (`!` `●` `○` `»` `└`); meaning carried by colour.
  No emoji — they render double-width inconsistently and break alignment.
- Filter, don't scroll: default view is `active`; header counts show what's hidden.
- Truncate names, never wrap; name column width is a function of `$COLUMNS`.

## Keymap

`↵` open · `n` new (not yet implemented) · `x` kill tmux (not yet implemented) ·
`a` archive (not yet implemented) · `r` rename (not yet implemented) · `f` filter ·
`?` keys · `q` quit
