#!/bin/zsh -l
# -l sources .zshenv + .zprofile but NOT .zshrc (zshrc is interactive-only).
# Most users put PATH additions for claude (npm/bun/brew global bins) in
# .zshrc, so source it explicitly here.
[[ -r ~/.zshrc ]] && source ~/.zshrc 2>/dev/null

# ORPHEUS_CLAUDE_FLAGS — whitespace-separated CLI flags composed by Orpheus
# from the user's Settings (e.g., "--model opus --permission-mode acceptEdits").
# ORPHEUS_CLAUDE_SETTINGS_JSON — inline JSON blob for --settings, covering
# settings.json-only keys (alwaysThinkingEnabled, outputStyle, tui, editorMode,
# prefersReducedMotion). Empty when no such keys differ from claude's defaults.

# Build flags array from ORPHEUS_CLAUDE_FLAGS using zsh word-splitting (${=VAR}).
local -a flags=()
if [[ -n "${ORPHEUS_CLAUDE_FLAGS:-}" ]]; then
  flags=(${=ORPHEUS_CLAUDE_FLAGS})
fi

# IMPORTANT: `exec` replaces this zsh process with claude. Without exec,
# claude would be a child of a non-interactive zsh holding the controlling
# TTY, which leaves claude one process away from the PTY foreground-group
# slot it needs — symptom is stalled spinner/animation until a keystroke
# pokes the pipeline. With exec, the process tree is just:
#   ghostty pty → login → bash → claude   (claude IS the foreground group)
if [[ -n "${ORPHEUS_CLAUDE_SETTINGS_JSON:-}" ]]; then
  exec claude --settings "${ORPHEUS_CLAUDE_SETTINGS_JSON}" "${flags[@]}"
else
  exec claude "${flags[@]}"
fi

# Only reached if exec failed (claude binary not on PATH, etc.). Drop into
# an interactive zsh so the user can debug — and exec so we don't keep
# a script-shell parent around.
echo
echo "[orpheus-claude: failed to exec claude — dropping to interactive zsh]"
exec zsh -i
