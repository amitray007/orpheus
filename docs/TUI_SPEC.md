# Orpheus TUI + tmux hosting — implementation spec

Status: in progress on `claude/tmux-tailscale-streaming-w1x5s3`.

Goal: one `orpheus tui` surface that runs locally **and** over SSH (Tailscale +
Termius) from a phone, listing projects/workspaces in desktop-sidebar order with
live status, and opening a workspace's terminal into a **tmux**-hosted session
that survives the SSH link dropping.

## Decisions (owner-delegated, locked)

| # | Decision |
| - | -------- |
| D1 | **Two disjoint hosts, first-opener wins.** In-app workspaces keep their libghostty surface untouched. Workspaces opened from the TUI are hosted by tmux. The in-app UI shows a tmux-hosted workspace as a placeholder with live status + an "Attach here" action that mounts ghostty running `tmux attach`. Never re-host implicitly. |
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

Request `{ id }` → `{ sessionName, socketName, created, alreadyRunning }`.

Main composes the launch via `composeClaudeLaunch(projectId, workspaceId)` and
creates the session with `tmux -L <socket> new-session -d -s <name> -e KEY=VAL …`.
Every env var goes through `-e` — the tmux **server** is a long-lived daemon and
sessions otherwise inherit the server's environment, not the client's, which
would silently break `ORPHEUS_CLAUDE_FLAGS`, `ORPHEUS_WORKSPACE_ID` and auth env.
The command is `resources/orpheus-claude.sh`, exactly as the ghostty path uses.

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

`↵` open · `n` new · `x` kill tmux · `a` archive · `r` rename · `f` filter · `?` keys · `q` quit
