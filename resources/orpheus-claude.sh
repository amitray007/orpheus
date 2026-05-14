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

if [[ -n "${ORPHEUS_CLAUDE_SETTINGS_JSON:-}" ]]; then
  claude --settings "${ORPHEUS_CLAUDE_SETTINGS_JSON}" "${flags[@]}"
else
  claude "${flags[@]}"
fi

echo
echo "[claude exited — dropping to interactive zsh]"
exec zsh -i
