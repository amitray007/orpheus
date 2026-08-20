#!/bin/zsh -l
# Codex CLI launch wrapper. Generic PATH/shell-init/flag-splitting setup
# lives in harness-common.sh (sourced below); this file keeps only the parts
# specific to the `codex` binary. See harness-common.sh's own header for the
# full rationale on PATH injection, user shell-init, and the 0x1F flag
# protocol — it is not repeated here.

# Resolve harness-common.sh as a sibling of THIS script, robustly, in both
# layouts this file ships in:
#   Packaged: Contents/Resources/orpheus-codex.sh + Contents/Resources/harness-common.sh
#   Dev:      <repo>/resources/orpheus-codex.sh   + <repo>/resources/harness-common.sh
# `${0:A:h}` is zsh's built-in "absolute directory of this script" modifier —
# it resolves symlinks and relative invocation alike (unlike bash's
# `dirname "${BASH_SOURCE[0]}"`, which does not chase symlinks), so it holds
# whether this script is invoked directly, via tmux's `command` (an absolute
# path — see tmuxHost.ts), or via `exec -l`.
typeset __orpheus_common="${0:A:h}/harness-common.sh"
if [[ -r "${__orpheus_common}" ]]; then
  source "${__orpheus_common}"
else
  echo "[orpheus-codex] FATAL: harness-common.sh not found at ${__orpheus_common} — cannot launch codex." >&2
  echo "[orpheus-codex] this is a packaging bug (harness-common.sh missing from extraResources)." >&2
  exec zsh -i
fi
unset __orpheus_common

# Unlike orpheus-claude.sh, there is no per-session self-identification env
# block to strip here — CLAUDECODE/CLAUDE_CODE_* are Claude Code's own
# nested-session markers and have no Codex analogue.

# No --settings equivalent exists on Codex (CODEX_CAPABILITIES.inlineSettingsJson
# is false — see src/main/harness/codex/curated.ts), so composeCodexHarnessLaunch
# always produces an empty ORPHEUS_HARNESS_SETTINGS_JSON and there is nothing
# for a conditional branch here to key off — just run codex with the
# harness-common.sh-composed flags array.
codex "${flags[@]}"

echo
echo "[codex exited — dropping to zsh]"
exec zsh -i
