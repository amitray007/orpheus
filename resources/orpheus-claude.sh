#!/bin/zsh -l
# -l sources .zshenv + .zprofile but NOT .zshrc (zshrc is interactive-only).
#
# Fast PATH injection: Orpheus captures the user's full shell PATH once at app
# start (login+interactive shell spawn) and injects it as ORPHEUS_USER_PATH.
# Applying it here gives claude the correct PATH (where npm/bun/brew global
# bins live) without sourcing ~/.zshrc upfront — which can cost 100-800ms of
# plugin/completion init. The interactive `exec zsh -i` tail at the bottom of
# this script still sources ~/.zshrc, so the user's prompt and aliases are
# fully available once claude exits.
#
# Safety fallback: if ORPHEUS_USER_PATH is empty/unset (capture failed, or
# this is the rare first mount before the async spawn resolved), OR if claude
# is not found on the injected PATH, we source ~/.zshrc as a last resort so
# users whose `claude` is only on the .zshrc PATH are never left stranded.
[[ -n "${ORPHEUS_USER_PATH:-}" ]] && export PATH="${ORPHEUS_USER_PATH}"
command -v claude >/dev/null 2>&1 || { [[ -r ~/.zshrc ]] && source ~/.zshrc 2>/dev/null; }
# Prepend the Orpheus bin dir (where the `orpheus` CLI shim lives) to PATH.
# ORPHEUS_BIN_DIR is injected by buildMountEnv to point at Contents/Resources/bin.
# Prepending after ORPHEUS_USER_PATH is applied so `orpheus` wins over any stale
# system-level installation, but user tools (npm, bun, etc.) also remain reachable.
[[ -n "${ORPHEUS_BIN_DIR:-}" ]] && export PATH="${ORPHEUS_BIN_DIR}:${PATH}"

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
echo "[claude exited — dropping to zsh]"
exec zsh -i
