# Phase 1 — Handoff: what to produce, where it goes, how to report done

## Artifacts

### 1. The Swift Package itself
- Location: `~/code/projects/orpheus/packages/OrpheusCore/`.
- Structure per `tasks.md` Group 1.
- Committed to the orpheus code repo with a clear commit message per repo convention. Commit incrementally as logical chunks complete (per the "commit as you go" workflow established during Phase 0) — at minimum: scaffold, persistence, settings, sessions, subprocess, smoke, README + AGENTS.

### 2. Smoke executable
- Target: `OrpheusCoreSmoke` inside the same package.
- Runnable via `swift run OrpheusCoreSmoke` from the package root.
- Prints a one-page report demonstrating each subsystem against a temp DB + temp `~/.claude/projects/` fixture. Exits 0 on success, non-zero with a labelled failure on the first stage that throws.

### 3. Package README
- `packages/OrpheusCore/README.md`.
- Contents:
  - What `OrpheusCore` is + how to import.
  - Module-by-module summary (Model, Persistence, Settings, Sessions, Watchers, Subprocess).
  - The "no UI imports" rule + the rest of the discipline (cross-link to `AGENTS.md`).
  - "How to consume from a UI module" snippet showing a `Database` open, a `Project` insert, and an `AsyncStream` subscription.
  - "Running the smoke executable" section.
  - Decisions locked in this phase (migration strategy, scrollback chunk size, debounce window).

### 4. Package AGENTS
- `packages/OrpheusCore/AGENTS.md` — backend-flavoured analogue of `packages/OrpheusDesign/AGENTS.md`.
- Spell out the same conventions Phase 0 codified, adapted for a non-UI library:
  - Public surface = `public struct …` or `public actor …`.
  - No `import SwiftUI` / `AppKit` / `OrpheusDesign`.
  - All I/O is `async throws`.
  - Migrations are additive.
  - Errors are typed.
  - Comments default to none — only when WHY is non-obvious.

### 5. Tests
- `Tests/OrpheusCoreTests/` with at minimum:
  - Model + migration tests (Group 8 § 30).
  - Integration tests for repositories (§ 31).
  - Settings tests (§ 32).
  - JSONL parser tests (§ 33).
  - Session registry tests (§ 34).
  - Subprocess tests (§ 35).
  - Concurrency tests (§ 36).
  - Discipline lint tests (§ 39).

## How to report done

When gate criteria are met, **create a session file** in the thoughts repo:

**Path:** `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/YYYY-MM-DD-HHMM-review-phase-1-core-foundation-build.md`

**Naming:** `YYYY-MM-DD-HHMM-review-phase-1-core-foundation-build.md`. Use **IST timezone** for the date/time. `review` is the verb (this is a review of the build). The slug `phase-1-core-foundation-build` must not contain any verb words.

**Contents (template):**

```markdown
# Review — Phase 1 Core Foundation build

**Date:** YYYY-MM-DD IST
**Verb:** review
**Context:** Phase 1 (`OrpheusCore` Swift Package) build completed. Reporting against the brief at `docs/agent-briefs/v1/`.

---

## Gate criteria check

- [x] / [ ] Data model persisted and round-trips through SQLite cleanly
- [x] / [ ] `claude` can be spawned and exit-code-handled from core
- [x] / [ ] Session registry populates and updates reactively
- [x] / [ ] Settings merge predictably across global + project scopes
- [x] / [ ] `swift run OrpheusCoreSmoke` produces the human-verifiable report

## Deliverables — what was produced

- **Package location:** <path>
- **Version / commit(s):** <sha + scope of each>
- **Smoke executable:** runnable via `<command>`

## Modules implemented

- Model: <list of types>
- Persistence: <tables + migrations + repositories>
- Settings: <sections + merger + watcher>
- Sessions: <registry + parser + indexer + watcher>
- Subprocess: <SubprocessManager + ClaudeProcess + flag builder>

## Decisions locked

- SQLite migration strategy: <choice + reasoning>
- Scrollback chunk size + ring bounds: <choice>
- Settings hot-reload debounce: <choice>
- Anything else lock-worthy: <list>

## Open items / TODOs stubbed

- <any subsystem that shipped as a partial>

## Discipline-rule violations (with justifications if any)

- <any cases where a rule had to bend; must be a short list or empty>

## Spec gaps encountered

- <any architectural details that weren't in `architecture.md` or `plan.md`; what placeholder was used>

## External-reference issues

- <Claude Code flag drift, GRDB version concerns, FSEvents quirks, etc.>

## Suggestions for Phase 2 / 3 integration

- <brief notes on how UI phases should consume OrpheusCore; call out any API surface that feels awkward>
```

### Commit message for the handoff session file

Write a `.commit-msg` at `/Users/maverick/code/projects/thoughts/projects/orpheus/.commit-msg` before reporting done:

```
[orpheus] review: Phase 1 OrpheusCore Swift Package build complete
```

### Update `docs/plan.md` Phase 1 status

Add a status line near the top of the Phase 1 section in the **code repo**:

```markdown
**Status as of YYYY-MM-DD:** ✅ DONE. See `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/YYYY-MM-DD-HHMM-review-phase-1-core-foundation-build.md`.
```

### Update `docs/queue.md`

Move Phase 1 from **Now** to **Done** with the date and commit reference. Move Phase 2 from **Next** into **Now** if the user is ready to start it (otherwise leave Now empty and surface that in the handoff).

## If blocked

If a hard blocker emerges — spec gap, schema design conflict, Claude Code flag missing, GRDB version incompatibility — **do not proceed past it**. Create a session file:

**Path:** `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/YYYY-MM-DD-HHMM-review-phase-1-blocked-<short-reason>.md`

**Contents:**
- What you were trying to do.
- What's blocking.
- What you've ruled out.
- Proposed resolution(s) for user to choose from.
- What's safe to continue on in parallel while awaiting resolution.

User will create a follow-up session to unblock. Do not merge or deploy a blocked build.

## Do not

- Do not modify `docs/specs/*`, `docs/wireframes/*`, or any other LOCKED file. They live in the code repo now and are still LOCKED.
- Do not invent tables, modules, or APIs not in `architecture.md` or this brief. Raise gaps instead.
- Do not add external Swift package dependencies beyond GRDB.swift without flagging in handoff.
- Do not touch `packages/OrpheusDesign/`.
- Do not skip the smoke executable — it's the human-verifiable gate.
- Do not skip incremental commits — commit per logical chunk and let `git log` tell the story.
