#!/bin/zsh -l
# -l sources .zshenv + .zprofile but NOT .zshrc (zshrc is interactive-only).
# Most users put PATH additions for claude (npm/bun/brew global bins) in
# .zshrc, so source it explicitly here.
[[ -r ~/.zshrc ]] && source ~/.zshrc 2>/dev/null

# Enable job control / monitor mode. By default, non-interactive zsh does NOT
# do the setpgid + tcsetpgrp dance for foreground commands — so a child like
# `claude` stays in this script's process group instead of becoming a process
# group leader that owns the PTY foreground slot. libghostty's renderer keys
# off that state (it learns "new frame ready" through TTY mechanisms that only
# the actual FG-group leader can trigger), and without it the spinner/animation
# pipeline stalls until a keypress forcibly refreshes things.
#
# `setopt monitor` enables full job control even in a non-interactive shell,
# so when we run claude below it gets its own pgrp + the FG slot — exactly
# like running it from an interactive zsh prompt. Animations work from frame 0.
setopt monitor

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

# NOTE: deliberately do NOT `exec` here — we want the wrapper to outlive
# claude so we can drop the user into a real interactive shell when claude
# exits. `setopt monitor` above already makes claude the PTY foreground
# group leader, so leaving the wrapper around as parent doesn't hurt rendering.
if [[ -n "${ORPHEUS_CLAUDE_SETTINGS_JSON:-}" ]]; then
  claude --settings "${ORPHEUS_CLAUDE_SETTINGS_JSON}" "${flags[@]}"
else
  claude "${flags[@]}"
fi

echo
echo "[claude exited — dropping to interactive zsh]"
exec zsh -i
