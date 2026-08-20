#!/bin/zsh -l
# -l sources .zshenv + .zprofile but NOT .zshrc (zshrc is interactive-only).
#
# Fast PATH injection: Orpheus captures the user's full shell PATH once at app
# start (login+interactive shell spawn) and injects it as ORPHEUS_USER_PATH.
# Applying it here gives the harness binary the correct PATH (where npm/bun/
# brew global bins live) without sourcing ~/.zshrc upfront — which can cost
# 100-800ms of plugin/completion init. The interactive `exec zsh -i` tail at
# the bottom of this script still sources ~/.zshrc, so the user's prompt and
# aliases are fully available once the harness exits.
#
# Safety fallback: if ORPHEUS_USER_PATH is empty/unset (capture failed, or
# this is the rare first mount before the async spawn resolved), OR if the
# harness binary is not found on the injected PATH, we source ~/.zshrc as a
# last resort so users whose harness binary is only on the .zshrc PATH are
# never left stranded.
#
# ORPHEUS_HARNESS_BINARY names the executable to probe for (descriptor.binary,
# e.g. 'claude', 'codex') and is injected by buildMountEnv. This file is
# SHARED by every harness's wrapper script, so the probe must not hardcode
# 'claude'. The `:-claude` default mirrors ORPHEUS_HARNESS_FLAGS's own
# rollback contract below: a wrapper script launched by an OLD main process
# during a partial upgrade/rollback may not have ORPHEUS_HARNESS_BINARY set
# at all, and falling back to 'claude' keeps that old-main/new-wrapper
# combination working exactly as it did before this var existed.
[[ -n "${ORPHEUS_USER_PATH:-}" ]] && export PATH="${ORPHEUS_USER_PATH}"
command -v "${ORPHEUS_HARNESS_BINARY:-claude}" >/dev/null 2>&1 || { [[ -r ~/.zshrc ]] && source ~/.zshrc 2>/dev/null; }
# Prepend the Orpheus bin dir (where the `orpheus` CLI shim lives) to PATH.
# ORPHEUS_BIN_DIR is injected by buildMountEnv to point at Contents/Resources/bin.
# Prepending after ORPHEUS_USER_PATH is applied so `orpheus` wins over any stale
# system-level installation, but user tools (npm, bun, etc.) also remain reachable.
[[ -n "${ORPHEUS_BIN_DIR:-}" ]] && export PATH="${ORPHEUS_BIN_DIR}:${PATH}"

# User-controlled shell init (Orpheus settings). Runs AFTER PATH setup so
# tools are reachable, and BEFORE the harness launches. ORPHEUS_SOURCE_ZSHRC
# sources the user's full interactive rc; ORPHEUS_PRE_LAUNCH_SNIPPET is
# free-text shell (e.g. `eval "$(direnv export zsh)"`) eval'd verbatim. Both
# are opt-in user config.
[[ "${ORPHEUS_SOURCE_ZSHRC:-}" == "1" && -r ~/.zshrc ]] && source ~/.zshrc 2>/dev/null
[[ -n "${ORPHEUS_PRE_LAUNCH_SNIPPET:-}" ]] && eval "${ORPHEUS_PRE_LAUNCH_SNIPPET}"

# ORPHEUS_HARNESS_FLAGS — pre-separated argv tokens composed by Orpheus from
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
# ORPHEUS_HARNESS_SETTINGS_JSON — inline JSON blob for --settings, covering
# settings.json-only keys (alwaysThinkingEnabled, outputStyle, tui, editorMode,
# prefersReducedMotion). Empty when no such keys differ from the harness's
# defaults.
#
# Legacy fallback (drop in Phase 5): the main process now emits BOTH the
# ORPHEUS_HARNESS_* names above AND the legacy ORPHEUS_CLAUDE_* names, newest
# first. But a NEW wrapper (this file) can be launched by an OLD, not-yet-
# upgraded main process during a partial upgrade or rollback — that main
# process only knows how to emit ORPHEUS_CLAUDE_FLAGS/ORPHEUS_CLAUDE_SETTINGS_JSON.
# So this script prefers the new names and falls back to the old ones rather
# than assuming the new names are always present.
: "${ORPHEUS_HARNESS_FLAGS:=${ORPHEUS_CLAUDE_FLAGS:-}}"
: "${ORPHEUS_HARNESS_SETTINGS_JSON:=${ORPHEUS_CLAUDE_SETTINGS_JSON:-}}"

# Build flags array from ORPHEUS_HARNESS_FLAGS by splitting on 0x1F. This
# idiom (${(@ps:\x1f:)VAR}) is the one verified end-to-end (real env var,
# real execve, real zsh) to preserve every token exactly — spaces, `=`, and
# nested quotes all survive intact.
local -a flags=()
if [[ -n "${ORPHEUS_HARNESS_FLAGS:-}" ]]; then
  flags=("${(@ps:\x1f:)ORPHEUS_HARNESS_FLAGS}")
fi

# ORIGIN HYGIENE — unset the launch-composition vars now that `flags` holds
# their parsed content. Without this they leak into the harness process and
# EVERY descendant of it, including a shell the user runs Orpheus itself from
# (the normal dev loop). That app process then inherits them, hands them to
# the tmux server as its GLOBAL env (tmuxSpawnEnv passes {...process.env}),
# and a later pane whose own composed flags are empty falls through to this
# same fallback and launches with the OUTER app's argv — which is how
# `codex` ended up being handed Claude's `--permission-mode`. `flags` is
# already built, so nothing below needs these. Harmless when absent.
unset ORPHEUS_CLAUDE_FLAGS ORPHEUS_HARNESS_FLAGS

# NOTE: this file only prepares the environment/`flags` array — it does not
# invoke the harness binary or exec the interactive-shell tail itself. The
# sourcing wrapper (e.g. orpheus-claude.sh) runs the harness-specific
# invocation using `flags`, THEN execs `zsh -i` after the harness exits, so
# the terminal stays alive for further use. Sourcing this file must never
# `exec` — that would skip the harness invocation entirely.
