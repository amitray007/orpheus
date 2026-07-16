#!/bin/zsh -l
# -l sources .zshenv + .zprofile but NOT .zshrc (zshrc is interactive-only) —
# same fast-PATH-injection rationale as orpheus-claude.sh (see that script's
# own header for the full explanation).
#
# Workbench Panes tab (U12) — generic per-pane launcher. Unlike
# orpheus-claude.sh (which unconditionally execs `claude`), this wrapper runs
# an ARBITRARY user-declared command (ORPHEUS_PANE_CMD, composed by
# src/main/index.ts's pane:mount handler) and then drops to an interactive
# shell once that command exits, so the pane surface stays alive/interactive
# for further use instead of dying with the command. An empty ORPHEUS_PANE_CMD
# ("just a shell" — see src/main/paneStore.ts's own doc comment) skips
# straight to the interactive shell.
[[ -n "${ORPHEUS_USER_PATH:-}" ]] && export PATH="${ORPHEUS_USER_PATH}"
[[ -n "${ORPHEUS_BIN_DIR:-}" ]] && export PATH="${ORPHEUS_BIN_DIR}:${PATH}"

if [[ -n "${ORPHEUS_PANE_CMD:-}" ]]; then
  eval "${ORPHEUS_PANE_CMD}"
  echo
  echo "[pane command exited — dropping to zsh]"
fi

exec zsh -i
