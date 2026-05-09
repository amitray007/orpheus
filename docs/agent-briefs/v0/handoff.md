# Phase 0 — Handoff: what to produce, where it goes, how to report done

## Artifacts

### 1. The Swift Package itself
- Location: `~/code/projects/orpheus/packages/OrpheusDesign/` inside the Orpheus monorepo. Future phases add siblings under `packages/` and an app target at `apps/Orpheus/`. The thoughts repo (`/Users/maverick/code/projects/thoughts/`) is **planning-only** — no code lives there; only session reports.
- Structure per `tasks.md` Group 1 scaffold.
- Committed to the orpheus repo with a clear commit message per repo convention.

### 2. Catalog preview app
- Target: `OrpheusDesignCatalog` executable inside the same package.
- Runnable via `swift run OrpheusDesignCatalog` from the package root.
- Shows every token + every component in both themes with labels.

### 3. Package README
- `Sources/OrpheusDesign/README.md` (or package root README).
- Contents:
  - What `OrpheusDesign` is + how to import.
  - The **8 discipline rules** (transcribed from `discipline.md` in this brief) as a checklist for contributors.
  - Token categories with a one-line description each.
  - Component categories with a one-line description each.
  - How to run the catalog.

### 4. Tests
- `Tests/OrpheusDesignTests/` with at minimum:
  - Token-value tests (font loading succeeds, contrast ratios pass WCAG AA).
  - Component smoke tests (each component can be instantiated without crashing).
  - Snapshot tests if practical.

## How to report done

When gate criteria are met, **create a session file** in the thoughts repo:

**Path:** `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/YYYY-MM-DD-HHMM-review-phase-0-design-system-build.md`

**Naming:** `YYYY-MM-DD-HHMM-review-phase-0-design-system-build.md`. Use **IST timezone** for the date/time. `review` is the verb (this is a review/retrospective of the build). The slug `phase-0-design-system-build` must not contain any verb words.

**Contents (template):**

```markdown
# Review — Phase 0 Design System build

**Date:** YYYY-MM-DD IST
**Verb:** review
**Context:** Phase 0 (OrpheusDesign Swift Package) build completed. Reporting against the brief at docs/agent-briefs/v0/.

---

## Gate criteria check

- [x] / [ ] Every token category locked with values
- [x] / [ ] Core component set compiles with preview samples
- [x] / [ ] Dark + light palettes both complete at the token level
- [x] / [ ] No stock SwiftUI controls referenced in the design-system package

## Deliverables — what was produced

- **Package location:** <repo path>
- **Version / commit:** <sha>
- **Catalog app:** runnable via `<command>`

## Tokens implemented

- Colors: <list>
- Typography: <list>
- Spacing / radii: <list>
- Motion: <list>
- Materials: <list>
- Icons: <list>

## Components implemented

- <list all, with state coverage per component>

## Open items / TODOs stubbed

- <any component that shipped as a partial>

## Discipline-rule violations (with justifications if any)

- <any cases where a rule had to bend; must be a short list or empty>

## Spec gaps encountered

- <tokens/materials/motion values that weren't in design-principles.md; what placeholder was used>

## External-reference issues

- <any licensing, font-loading, macOS version issues>

## Suggestions for Phase 1 / 2 integration

- <brief notes on how feature phases should consume OrpheusDesign; call out any API surface that feels awkward>
```

### Commit message for the session file

Write a `.commit-msg` at `projects/orpheus/.commit-msg` before Stop hook fires:
```
[orpheus] review: Phase 0 OrpheusDesign Swift Package build complete
```

### Update `docs/plan.md` Phase 0 status

Add a status line near the top of the Phase 0 section:
```markdown
**Status as of YYYY-MM-DD:** ✅ DONE. See `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/YYYY-MM-DD-HHMM-review-phase-0-design-system-build.md`.
```

## If blocked

If a hard blocker emerges — spec gap, licensing issue, architecture question — **do not proceed past it**. Create a session file:

**Path:** `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/YYYY-MM-DD-HHMM-review-phase-0-blocked-<short-reason>.md`

**Contents:**
- What you were trying to do.
- What's blocking.
- What you've ruled out.
- Proposed resolution(s) for user to choose from.
- What's safe to continue on in parallel while awaiting resolution.

User will create a follow-up session to unblock. Do not merge or deploy a blocked build.

## Do not

- Do not modify `docs/specs/design-principles.md` (it's LOCKED).
- Do not modify `docs/specs/architecture.md` (LOCKED).
- Do not modify wireframes (LOCKED).
- Do not invent tokens, materials, or components not in the spec. Raise gaps instead.
- Do not add external Swift package dependencies without flagging in handoff.
- Do not commit Satoshi font files without verifying the license.
- Do not skip the catalog app — it's the human-verifiable gate.
