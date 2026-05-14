# Working with this user — preferences and patterns

This file captures how the user (Amit) likes to work on Orpheus. New Claude sessions should read this alongside the auto-memory files in `/Users/maverick/.claude/projects/-Users-maverick-code-projects-orpheus/memory/`.

## Build + verify loop (NON-NEGOTIABLE)

The user wants every code change verified through a real production build, not a dev server. The exact iteration cycle is:

```
1. osascript -e 'tell application "Orpheus" to quit' 2>/dev/null
2. sleep 1
3. pkill -x Orpheus 2>/dev/null; true     # defensive, in case quit didn't take
4. bun run build:unpack                    # full prod build + sign + install to /Applications/Orpheus.app
5. open /Applications/Orpheus.app          # relaunch
```

**Do this without asking.** The user has stated explicitly that they don't want to be asked permission to close and reopen the app — that's overhead. Just run the sequence as part of finishing a change.

**Never use `bun run dev`** (or the Tauri equivalent). The icon and bundle diverge from the shipped version, signing differs, and you'll waste time on issues that only exist in dev. Production-only.

**For native addon changes**, the same `bun run build:unpack` rebuilds the addon too (the chain runs `bun run build:native` first). Don't shortcut to `bun run build` — you'll skip the native rebuild.

## Commit + push cadence

- **Commit per logical chunk.** Not at the end of a long session — at every coherent milestone. The user wants to see incremental progress on `origin/main` (or whatever branch is active).
- **Push immediately after committing.** `git push origin <branch>` is part of every chunk.
- **Conventional commit subjects.** Short imperative verb + scope. Examples:
  - `feat(settings): add fuzzy search bar`
  - `fix(ghostty-native): drop wantsLayer override`
  - `chore(ghostty-native): 500ms diag timer`
  - `revert: roll addon.mm back to dcbd1f9`
- **Body explains the why.** A few short paragraphs is fine. Cite line numbers / source files when relevant.
- **Use HEREDOC for multi-line commit messages** (Bash tool spec).
- **No emoji.** Anywhere.
- **No `Co-Authored-By` Claude lines unless adding intentionally.**

## Trust but verify

The user expects me to actually check that things work — not just claim done. After every code change:

- For native changes: confirm the build succeeded, app launched (`pgrep -lf "Orpheus.app/Contents/MacOS/Orpheus" | head -1`), and that any specific artifact (shim file, hook file, schema migration) is present.
- For SQLite changes: run `sqlite3` against `~/Library/Application Support/Orpheus/orpheus.sqlite` to verify columns/values exist.
- For renderer changes: production build path proves the bundle is consistent. UI-flow verification is the user's job unless I genuinely have a way to drive the UI.

If something can't be verified (e.g., a long-running UI flow requires user interaction), say so explicitly. Don't claim success blindly.

## Delegation and parallelism

- **Sonnet subagents for non-trivial work.** Multi-file features, schema + UI + IPC changes, anything that would take 10+ tool calls — delegate. Brief the agent like a colleague who just walked in: full context, exact file paths, success criteria, standing rules.
- **Parallel research agents** when investigating things. Two or three agents working on different angles in parallel, then synthesize their findings. The user has called this out as a strength of the workflow.
- **Direct source reads beat agent summaries** for tricky low-level work. When two parallel agents missed a subtle bug in libghostty embedding, the fix surfaced in one focused read of the upstream `Metal.zig`. Trust agent summaries for breadth; do direct reads for depth.

## Response style

- **Brief and scannable.** Tables for comparisons, code fences for diffs, headers for sections. The user reads quickly and wants the structure to help them skim.
- **Don't narrate internal deliberation.** State results and decisions; skip the "let me think about this" framing.
- **One sentence per update during work.** Not a paragraph. Just: "Fixing X" / "Built, app launched" / "Pushed as `abc1234`."
- **End-of-turn summary: 1-2 sentences.** What changed, what's next. No more.
- **Lead with the answer, not the reasoning.** If the user asks "is X possible?", say yes/no first, then the why. They'll ask follow-ups.

## What to ask vs decide

- **Decide and ship for clearly bounded choices.** Default styling, name of a new SQL column, internal function structure — just pick and ship. The user trusts taste on the small stuff.
- **Ask when there's a real trade-off.** Where a feature lives in the UI, whether to add a settings toggle, which of three architectural approaches to take. Use `AskUserQuestion` with up to 4 options. Include `preview` content (monospace mockups) when comparing visual layouts.
- **Don't ask permission for things the user has explicitly delegated** (build cycle, commit/push, native re-build).

## Design preferences

- **Wireframes are starting points, not strict specs.** Refine UI based on taste once structure is locked. Don't ship wireframe-faithful approximations when polish is the target.
- **Use spinners / skeletons / audio at the point of need.** In-tree `Spinner.tsx` (braille frames, 80ms), boneyard-js for skeletons (when relevant), `@web-kits/audio` for meaningful events. Don't ship bare loading states or silent successes.
- **Unicode glyph family for activity indicators.** Same shape vocabulary across all states (braille spinners, circle quarters, block bars, solid dots). No emoji.
- **Settings layout**: layered (global → project → workspace), internal-sidebar UI, multi-commit history. Plaintext SQLite for secrets (no Keychain until Developer ID signing lands).
- **Don't redesign without permission.** The current UI is the result of deliberate iteration; preserve it unless explicitly asked to change.

## Code style

- **No comments unless genuinely non-obvious.** No multi-paragraph docstrings. No comments that re-state what well-named identifiers already say. One short line max, and only for the *why* (hidden constraint, subtle invariant, workaround for a specific bug).
- **No emoji** in code or commit messages.
- **No hardcoded paths / URLs / lists.** Use env, config, OS APIs, shell PATH. Curated keyword catalogs for search are acceptable — they're the spec of a feature, not an environmental assumption.
- **Don't add error handling for impossible cases.** Trust internal code and framework guarantees. Validate at system boundaries (user input, external APIs) only.
- **Don't add features, refactors, or abstractions beyond what the task requires.** A bug fix doesn't need surrounding cleanup; a one-shot operation doesn't need a helper. Three similar lines is better than a premature abstraction.

## Memory and persistence

- **Auto-memory exists at** `/Users/maverick/.claude/projects/-Users-maverick-code-projects-orpheus/memory/`. Read `MEMORY.md` at the start of every new session. Update memories when learning new facts about the project, user preferences, or correcting wrong information.
- **`docs/deferred.md`** is the canonical "things we deferred" tracker. Cross-reference when finishing or starting work.
- **Don't create planning documents in the repo** unless asked. Work from conversation context.

## When stuck on a hard problem

The Electron → libghostty rendering saga was instructive:

- **Multiple speculative fixes layered on top of each other made things worse.** Each commit hypothesized a different cause and applied a different fix. Symptoms persisted, regressions piled up.
- **Direct source reads beat agent summaries for diagnosis.** The actual root cause was found in 5 minutes of reading upstream `Metal.zig` after agents had spent 600+ seconds of tool calls.
- **A single revert + rethink** is often better than another fix-on-top. When the user said "lets revert and rethink," the right move was a clean `git checkout <last-good-sha> -- <file>` and a single revert commit, not partial unwinding.
- **Architectural escapes are sometimes the right answer.** When the problem is the host environment (Chromium compositor) rather than the code, the fix isn't more code — it's moving the work to a different host (child NSWindow, Tauri, etc.).

## Things the user explicitly likes

- Detailed commit message bodies that cite source-file line numbers when relevant.
- Tables for state machines, glyph mappings, edge-case matrices.
- ASCII diagrams of layer/view/process trees when explaining architecture.
- Verification commands inline in the response ("paste this output").
- Brief acknowledgement of what's tested vs what isn't ("UI tested by hand; SQL verified via sqlite3; the watchdog timeout path is not exercised").

## Things the user dislikes

- Asking permission for the build cycle.
- Long preambles before the actual change.
- Speculation without source-citation when claiming things about libghostty / Electron / Tauri / etc.
- Multiple half-finished fixes accumulating without rollback.
- Documentation files (CHANGELOG, README updates, etc.) created without being asked.
