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

# User-controlled shell init (Orpheus settings). Runs AFTER PATH setup so
# tools are reachable, and BEFORE claude launches. ORPHEUS_SOURCE_ZSHRC sources
# the user's full interactive rc; ORPHEUS_PRE_LAUNCH_SNIPPET is free-text shell
# (e.g. `eval "$(direnv export zsh)"`) eval'd verbatim. Both are opt-in user config.
[[ "${ORPHEUS_SOURCE_ZSHRC:-}" == "1" && -r ~/.zshrc ]] && source ~/.zshrc 2>/dev/null
[[ -n "${ORPHEUS_PRE_LAUNCH_SNIPPET:-}" ]] && eval "${ORPHEUS_PRE_LAUNCH_SNIPPET}"

# ORPHEUS_CLAUDE_FLAGS — pre-separated argv tokens composed by Orpheus from
# the user's Settings (e.g. --model, --permission-mode, session continuity,
# and free-text custom CLI flags), joined with 0x1F (Unit Separator) rather
# than whitespace. Two reasons whitespace can't be the delimiter:
#   - Plain word-splitting (${=VAR}) cannot honor quotes: a value like
#     `--append-system-prompt "be terse and kind"` shreds into 5 tokens and
#     leaks the literal quote characters. Every zsh splitting idiom was
#     tried (${=VAR}, ${(z)VAR}, ${(zQ)VAR}) and none correctly round-trips
#     a quoted argv string from a single flat string — parsing must happen
#     in TypeScript (src/shared/cliFlags.ts), and the shell must receive
#     tokens that are already separated.
#   - NUL (\0) would be the natural choice for `${(0)VAR}` splitting, but env
#     vars are NUL-terminated C strings and cannot embed one (confirmed:
#     spawning a child process with a NUL-containing env value raises
#     "embedded null byte"). 0x1F is a control character that is legal in an
#     env var and never appears in real CLI arguments, so it's used instead.
# ORPHEUS_CLAUDE_SETTINGS_JSON — inline JSON blob for --settings, covering
# settings.json-only keys (alwaysThinkingEnabled, outputStyle, tui, editorMode,
# prefersReducedMotion). Empty when no such keys differ from claude's defaults.

# Build flags array from ORPHEUS_CLAUDE_FLAGS by splitting on 0x1F. This
# idiom (${(@ps:\x1f:)VAR}) is the one verified end-to-end (real env var,
# real execve, real zsh) to preserve every token exactly — spaces, `=`, and
# nested quotes all survive intact.
local -a flags=()
if [[ -n "${ORPHEUS_CLAUDE_FLAGS:-}" ]]; then
  flags=("${(@ps:\x1f:)ORPHEUS_CLAUDE_FLAGS}")
fi

if [[ -n "${ORPHEUS_CLAUDE_SETTINGS_JSON:-}" ]]; then
  claude --settings "${ORPHEUS_CLAUDE_SETTINGS_JSON}" "${flags[@]}"
else
  claude "${flags[@]}"
fi

echo
echo "[claude exited — dropping to zsh]"
exec zsh -i
