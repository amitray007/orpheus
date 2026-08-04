#!/bin/zsh -l
# -l sources .zshenv + .zprofile but NOT .zshrc (zshrc is interactive-only) —
# mirrors orpheus-claude.sh's own rationale.
#
# This is the DESKTOP-SURFACE-SIDE half of universal tmux hosting. The tmux
# SESSION itself (the thing that actually runs `claude`) is created by
# hostWorkspace() in src/main/tmuxHost.ts, which execs orpheus-claude.sh as
# the session's own command — completely unchanged by this script. This
# wrapper's only job is to get the native libghostty surface INTO that
# already-running session as an attached client, via `tmux attach-session`.
#
# ORPHEUS_TMUX_SOCKET / ORPHEUS_TMUX_SESSION are injected by
# buildTmuxAttachEnv() (src/main/tmuxHost.ts) — the SAME resolveTmuxSocketName()/
# tmuxSessionName() functions hostWorkspace() itself uses to create the
# session, so the names are computed exactly once (in TypeScript) and never
# re-derived here. Do not hardcode a socket/session name in this script.
if [[ -z "${ORPHEUS_TMUX_SOCKET:-}" || -z "${ORPHEUS_TMUX_SESSION:-}" ]]; then
  echo "[orpheus-attach] missing ORPHEUS_TMUX_SOCKET/ORPHEUS_TMUX_SESSION — cannot attach" >&2
  exec zsh -i
fi

# Minimal PATH setup — just enough that `tmux` itself resolves and (best
# effort) that the fallback shell below has the user's real tools. This
# script intentionally does NOT receive the full composeClaudeLaunch/
# buildMountEnv/auth env composition that orpheus-claude.sh gets — attaching
# to an existing session needs no claude flags, no settings JSON, no auth
# env, so none of that is passed here. See tmuxHost.ts's buildTmuxAttachEnv()
# doc comment for the full "no secrets on the attach path" rationale.
[[ -n "${ORPHEUS_USER_PATH:-}" ]] && export PATH="${ORPHEUS_USER_PATH}"
[[ -n "${ORPHEUS_BIN_DIR:-}" ]] && export PATH="${ORPHEUS_BIN_DIR}:${PATH}"
command -v tmux >/dev/null 2>&1 || { [[ -r ~/.zshrc ]] && source ~/.zshrc 2>/dev/null; }

# Defense-in-depth ONLY: the PRIMARY tmux-missing detection happens on the
# main-process side (tmuxHost.ts's ensureTmuxVersion(), consulted by
# terminal:mount BEFORE this script is ever chosen as the mount command —
# see resolveMountStrategy()'s native-fallback branch, which calls
# orpheus-claude.sh directly instead of this script when tmux is missing/too
# old). So this branch should almost never fire. It exists only for the
# narrow window where tmux was present when the main process checked but
# vanished before this script actually ran (uninstalled mid-session, an
# unusual PATH/environment mismatch, etc). Give it its OWN message —
# `tmux: command not found` followed by the generic "session ended" line
# below would be actively misleading (no session ever existed to end).
if ! command -v tmux >/dev/null 2>&1; then
  echo
  echo "[orpheus-attach] tmux is not installed — install it with \`brew install tmux\`."
  echo "[orpheus-attach] this workspace cannot use tmux hosting until then."
  exec zsh -i
fi

# Attach. This blocks for the lifetime of the client's attachment.
tmux -L "${ORPHEUS_TMUX_SOCKET}" attach-session -t "${ORPHEUS_TMUX_SESSION}"

# CRITICAL: `tmux attach-session` returns here for EVERY reason it can end —
# the session was killed (`x` from the TUI, `tmux kill-session` from
# anywhere), the tmux SERVER itself died or was killed
# (`tmux kill-server`, a crash), or some other detach-that-looks-like-exit
# condition. We deliberately do NOT try to distinguish these cases: the
# native addon's `wait_after_command = true` (packages/ghostty-surface,
# NOT modified by this change) keeps the surface alive after this script's
# process group exits, but ONLY as an inert pane unless something is
# actually running in it — so falling through to a plain shell prompt here
# is what stands between the user and a dead black rectangle, exactly the
# same problem orpheus-claude.sh solves with its own `exec zsh -i` tail
# after `claude` exits. One clear, generic line covers every exit reason
# above (it does not claim to know WHY tmux exited, just that it did):
echo
echo "[tmux session ended or was closed elsewhere]"
exec zsh -i
