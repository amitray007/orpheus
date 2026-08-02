# Remote access — driving Orpheus from a phone

Reach your Orpheus workspaces from anywhere over your tailnet, with sessions that
survive the connection dropping. Three pieces: **tmux** holds the process,
**Tailscale** carries the connection, **Termius** (or any SSH client) is the
terminal.

## What you get

`orpheus tui` lists every project and workspace in the same order as the desktop
sidebar, with live status, and opens any of them with one keypress. Because the
terminal is hosted by tmux, closing your phone — or losing signal in a tunnel —
leaves `claude` running. Reconnect and you are back where you were.

## Setup

### 1. Tailscale on the Mac

Install Tailscale and join your tailnet. Enable Tailscale SSH so you do not have
to manage keys:

```bash
tailscale up --ssh
```

Your Mac is now reachable at `<machine>.<tailnet>.ts.net` from any device signed
into the same tailnet. Access is governed by your tailnet ACLs — nothing is
exposed to the public internet.

### 2. Keep the Mac awake

A sleeping Mac answers nothing. Orpheus has a keep-awake control in Settings —
turn it on if you intend to reach the machine while away from it.

### 3. Termius

Add **one** host pointing at your Mac's tailnet name, and set its startup command
to:

```
orpheus tui
```

That is the whole client-side setup. You connect, and you are looking at your
sessions.

#### Optional: a host per project

Termius supports groups of hosts. If you work across several projects, one entry
each gives you project selection in Termius's own native UI — real tap targets
instead of a text menu — with the TUI handling only the sessions inside that
project:

```
Orpheus/
  orpheus   →  orpheus tui --project orpheus
  api       →  orpheus tui --project api
```

These entries are hand-maintained, but projects change far less often than
workspaces do.

### 4. Keyboard

Claude's TUI needs Esc, Ctrl, Tab and arrow keys. Termius's accessory bar
provides them; most stock mobile keyboards do not. This is the single biggest
factor in whether working from a phone feels usable — try attaching to a plain
tmux session for ten minutes before investing further.

## Using it

| Key | Action |
| --- | ------ |
| `↵` | Open the workspace's terminal |
| `n` | New session — not yet implemented |
| `x` | Kill the tmux session (workspace stays, resumable) — not yet implemented |
| `a` | Archive the workspace (also kills its tmux session) — not yet implemented |
| `r` | Rename — not yet implemented |
| `f` | Cycle filter — `active` → `all` |
| `?` | Key help |
| `q` | Quit |

Detaching from a session (`Ctrl-b d`) returns you to the list rather than
dropping you at a shell, so moving between tasks is two keystrokes.

The default `active` filter shows only workspaces that are working or waiting on
you. The header counts tell you what is hidden, so nothing urgent can hide behind
a filter.

## How hosting works

A workspace's terminal is hosted **either** by the desktop app's native surface
**or** by tmux — whichever opened it first. They are never both.

- Open a workspace in the desktop app → it runs in the app's native terminal, as
  it always has.
- Open it from `orpheus tui` → it runs in a tmux session.

Opening a tmux-hosted workspace in the desktop app will not start a second
`claude`; the app reports that it is hosted elsewhere instead.

Live status works identically either way, because status comes from `claude`'s
own session registry (`~/.claude/sessions/<pid>.json`) rather than from whoever
owns the terminal.

## Environment separation

Dev, production, worktree and nightly builds each get their **own tmux socket**,
derived from the same app-variant detection that separates their data
directories:

| App | Data dir | tmux socket |
| --- | -------- | ----------- |
| `Orpheus` | `~/Library/Application Support/Orpheus` | `orpheus` |
| `Orpheus Dev` | `…/Orpheus Dev` | `orpheus-dev` |
| `Orpheus WT` | `…/Orpheus WT` | `orpheus-wt` |
| `Orpheus Nightly` | `…/Orpheus Nightly` | `orpheus-nightly` |

A dev build can never list, attach to, or kill a production session. To reach a
dev session directly:

```bash
tmux -L orpheus-dev ls
```

## Troubleshooting

**`orpheus tui` says the app is not running.** The TUI talks to Orpheus over its
command socket. It will offer to launch the app; if that fails, start Orpheus on
the Mac and retry.

**Sessions are missing after a reboot.** tmux does not survive a restart. The
workspaces are still registered in Orpheus and resume from their transcripts on
next open — only the running processes are gone.

**The desktop terminal resized when I attached from my phone.** Expected when the
desktop has attached to the same tmux session. Sessions are created with
`window-size latest`, so the most recently active client sets the size.

**`tmux: command not found`.** Install it (`brew install tmux`). Only the tmux
hosting path needs it; the desktop app does not.
