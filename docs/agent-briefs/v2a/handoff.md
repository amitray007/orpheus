# Phase 2A — Handoff: what to produce, where it goes, how to report done

## Artifacts

### 1. The Swift Package itself
- Location: `~/code/projects/orpheus/packages/OrpheusTerminal/`.
- Structure per `tasks.md` Group 1.
- Committed to the orpheus code repo with clear commit messages per repo convention. Commit incrementally as logical chunks complete (per the "commit as you go" workflow established during Phase 0/1) — at minimum: scaffold, audit, engine wrapper, view layer, theme bridge, smoke executable, tests, README + AGENTS.

### 2. Audit document
- `packages/OrpheusTerminal/AUDIT.md`.
- Covers: pinned libghostty-spm tag, symbol verification, ShellCraftKit findings, Metal-layer hosting constraints, anything else Phase 2C should know.
- This is the artefact that future-you (and Phase 2C builders) consult when something is weird.

### 3. Smoke executable
- Target: `OrpheusTerminalSmoke` inside the package.
- Runnable via `swift run OrpheusTerminalSmoke` from the package root.
- Opens a real macOS window with a working terminal. The user types `ls` / `pwd` / `claude --version` and sees output.
- The window closes cleanly via ⌘W; no zombie shell processes left behind.

### 4. Package README
- `packages/OrpheusTerminal/README.md`.
- Contents:
  - What `OrpheusTerminal` is + how to import.
  - Module-by-module summary (Engine, View, Theme, Internal).
  - The discipline (cross-link to `AGENTS.md`).
  - "How to embed a terminal" snippet showing engine-init → makeSurface → OrpheusTerminalView usage.
  - "Running the smoke executable" section.
  - Decisions locked in this phase (binding strategy, libghostty-spm tag, audit findings summary, engine singleton policy, IME approach).
  - Pointer to `AUDIT.md`.

### 5. Package AGENTS
- `packages/OrpheusTerminal/AGENTS.md`.
- Discipline rules adapted for a UI + FFI library — same shape as `packages/OrpheusCore/AGENTS.md` and `packages/OrpheusDesign/AGENTS.md`.

### 6. Tests
- `Tests/OrpheusTerminalTests/` per `tasks.md` Group 7 (Engine, KeyEvent, Palette, smoke harness sanity).
- `Tests/DisciplineLintTests/` — lint target mirroring `OrpheusCore`'s.

## How to report done

When gate criteria are met, **create a session file** in the thoughts repo:

**Path:** `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/YYYY-MM-DD-HHMM-review-phase-2a-libghostty-ffi-build.md`

**Naming:** `YYYY-MM-DD-HHMM-review-phase-2a-libghostty-ffi-build.md`. Use **IST timezone** for the date/time. `review` is the verb. The slug `phase-2a-libghostty-ffi-build` must not contain any verb words.

**Contents (template):**

```markdown
# Review — Phase 2A libghostty FFI build

**Date:** YYYY-MM-DD IST
**Verb:** review
**Context:** Phase 2A (`OrpheusTerminal` Swift Package + libghostty-spm integration) build completed. Reporting against the brief at `docs/agent-briefs/v2a/`.

---

## Gate criteria check

- [x] / [ ] `swift build` for `packages/OrpheusTerminal/` is clean against the pinned libghostty-spm tag
- [x] / [ ] `swift run OrpheusTerminalSmoke` opens a 720×440 macOS window
- [x] / [ ] The window contains a libghostty-rendered terminal surface (Metal-backed, GPU-accelerated)
- [x] / [ ] The terminal spawns the user's `$SHELL` at app start
- [x] / [ ] Keyboard input reaches the shell
- [x] / [ ] Shell output renders back into the surface
- [x] / [ ] Resizing the window resizes the terminal correctly
- [x] / [ ] Closing the window terminates the shell process cleanly (no zombie)
- [x] / [ ] The terminal honours one OrpheusDesign palette mapping
- [x] / [ ] Basic shell integration: cd, ls, pwd, claude --version (if installed) all behave normally

## Deliverables — what was produced

- **Package location:** <path>
- **Pinned libghostty-spm tag:** <tag>
- **Version / commit(s):** <sha + scope of each>
- **Smoke executable:** runnable via `<command>`
- **AUDIT.md:** <link>

## Modules implemented

- Engine: <list of types>
- View: <list of types>
- Theme: <list of types>
- Internal: <list of helpers>

## Audit findings

- ShellCraftKit / unsandboxed spawn: <pass/fail + notes>
- Metal layer hosting: <pass/fail + notes>
- C ABI symbol verification: <pass/fail + notes>
- Anything Phase 2C should be aware of: <list>

## Decisions locked

- libghostty binding strategy: <Lakr233/libghostty-spm + reasoning>
- Pinned tag: <tag + why>
- Engine lifecycle (singleton vs per-instance): <choice + reasoning>
- Window-close semantics: <choice + reasoning>
- IME approach: <Ghostty Surface.swift mirror + any deltas>

## Open items / TODOs stubbed

- <any subsystem that shipped as a partial>

## Discipline-rule violations (with justifications if any)

- <any cases where a rule had to bend; should be a short list or empty>

## Spec gaps encountered

- <any architectural details that weren't in the brief; what placeholder was used>

## External-reference issues

- <libghostty-spm bugs hit, Ghostty C-ABI quirks, IME edge cases, etc.>

## Suggestions for Phase 2C integration

- <how the OrpheusTerminalView should be composed with OrpheusCore>
- <any awkward API surface worth revisiting>
- <SubprocessManager interaction notes — Phase 2C will spawn `claude` via the surface's command/arguments, not via OrpheusCore.SubprocessManager>
```

### Commit message for the handoff session file

Write a `.commit-msg` at `/Users/maverick/code/projects/thoughts/projects/orpheus/.commit-msg` before reporting done:

```
[orpheus] review: Phase 2A OrpheusTerminal libghostty FFI build complete
```

### Update `docs/plan.md` Phase 2 status

Add a sub-phase status line near the top of the Phase 2 section in the **code repo**:

```markdown
**Phase 2A (libghostty FFI) status as of YYYY-MM-DD:** ✅ DONE. See `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/YYYY-MM-DD-HHMM-review-phase-2a-libghostty-ffi-build.md`.
```

(The full Phase 2 status doesn't flip until 2A + 2B + 2C are all done — leave the per-phase header alone.)

### Update `docs/queue.md`

Move Phase 2A from **Now** to **Done** with the date and commit reference. Move Phase 2B from **Next** into **Now** if the user is ready to start it (otherwise leave Now empty and surface that in the handoff).

## If blocked

Most likely blocker for Phase 2A is the audit (Group 2). If the audit reveals libghostty-spm's bundled binary forces sandboxed shell-only spawn, OR Metal-layer hosting requires a Ghostty-owned NSView we can't subclass, OR the C ABI symbols don't match upstream `ghostty.h`:

**Path:** `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/YYYY-MM-DD-HHMM-review-phase-2a-blocked-<short-reason>.md`

**Contents:**
- What you were trying to do.
- What's blocking (with concrete evidence: error messages, symbol dumps, runtime crashes).
- What you've ruled out.
- Proposed resolution(s) for user to choose from. Most likely: "fall back to building libghostty from source, hand-roll bindings" — but that's a different sub-phase needing user approval.
- What's safe to continue on in parallel while awaiting resolution (probably: documentation, tests for non-FFI utility code).

User will create a follow-up session to unblock. **Do not merge or deploy a blocked build.**

## Do not

- Do not modify `docs/specs/*`, `docs/wireframes/*`, or any other LOCKED file.
- Do not invent C-API entry points not in libghostty-spm's exposed surface — they don't exist.
- Do not add Swift package dependencies beyond `libghostty-spm` and `OrpheusDesign` without flagging in handoff.
- Do not touch `packages/OrpheusDesign/` (read-only).
- Do not touch `packages/OrpheusCore/` (read-only — and not even imported here).
- Do not skip the smoke executable — it's the human-verifiable gate.
- Do not skip the AUDIT.md — it's the contract Phase 2C reads when integrating.
- Do not skip incremental commits — commit per logical chunk.
- Do not try to handle the "libghostty needs to be built from source" fallback inline — that's a separate sub-phase.
