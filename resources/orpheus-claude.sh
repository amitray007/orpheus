#!/bin/zsh -l
# Claude Code launch wrapper. Generic PATH/shell-init/flag-splitting setup
# lives in harness-common.sh (sourced below); this file keeps only the parts
# specific to the `claude` binary. See harness-common.sh's own header for the
# full rationale on PATH injection, user shell-init, and the 0x1F flag
# protocol — it is not repeated here.

# Resolve harness-common.sh as a sibling of THIS script, robustly, in both
# layouts this file ships in:
#   Packaged: Contents/Resources/orpheus-claude.sh + Contents/Resources/harness-common.sh
#   Dev:      <repo>/resources/orpheus-claude.sh   + <repo>/resources/harness-common.sh
# `${0:A:h}` is zsh's built-in "absolute directory of this script" modifier —
# it resolves symlinks and relative invocation alike (unlike bash's
# `dirname "${BASH_SOURCE[0]}"`, which does not chase symlinks), so it holds
# whether this script is invoked directly, via tmux's `command` (an absolute
# path — see tmuxHost.ts), or via `exec -l`.
typeset __orpheus_common="${0:A:h}/harness-common.sh"
if [[ -r "${__orpheus_common}" ]]; then
  source "${__orpheus_common}"
else
  echo "[orpheus-claude] FATAL: harness-common.sh not found at ${__orpheus_common} — cannot launch claude." >&2
  echo "[orpheus-claude] this is a packaging bug (harness-common.sh missing from extraResources)." >&2
  exec zsh -i
fi
unset __orpheus_common

# Strip Claude Code's per-session self-identification vars. When Orpheus is
# launched from inside a Claude Code session these variables leak down the
# process tree and make each workspace's `claude` behave as a nested/child
# session — notably it skips registering itself in ~/.claude/sessions/<pid>.json
# and therefore never appears in `claude agents --json`. Unsetting them here
# (unconditionally, safe no-op when absent) guarantees every workspace claude
# starts as a clean, top-level session regardless of how Orpheus was launched.
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID \
      CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_EXECPATH \
      CLAUDE_CODE_SSE_PORT AI_AGENT

if [[ -n "${ORPHEUS_HARNESS_SETTINGS_JSON:-}" ]]; then
  claude --settings "${ORPHEUS_HARNESS_SETTINGS_JSON}" "${flags[@]}"
else
  claude "${flags[@]}"
fi

echo
echo "[claude exited — dropping to zsh]"
exec zsh -i
