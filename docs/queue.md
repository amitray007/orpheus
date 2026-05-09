# Queue

_Last updated: 2026-05-10 IST_

## Now

- Phase 1 brief — drafted at `docs/agent-briefs/v1/` (5 files: README, inputs, tasks, discipline, handoff). User to review before handing off to a builder agent. Decisions surfaced in `tasks.md` "Decisions to lock in this phase" — recommended defaults provided; user can override before build starts.

## Next

- Phase 1 build — Core Foundation, `OrpheusCore` Swift Package. Headless plumbing (data model, persistence, settings, session registry, JSONL watcher, subprocess manager). Smoke executable as the human-verifiable gate.
- Phase 2 build — Shell + Terminal. Requires Phase 0 (design system) + Phase 0.5 (wireframes) + Phase 1 (core).

## Done

- ✅ **Phase 0.5 — Wireframes & Flows** (2026-04-19) — 22 active v0 wireframes locked across 13 iterations + 4 archived post-v0. See `docs/wireframes/wireframes-v0.5.md` and `docs/agent-briefs/v0.5/lore.md`.
- ✅ **Phase 0 — Design-System Foundation, `OrpheusDesign`** (2026-05-09) — Swift Package shipped at `packages/OrpheusDesign/` with all token categories, 22 components, dark + light themes, and `OrpheusDesignCatalog` preview app. 84 tests, all gates green. Review session: `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-05-09-2128-review-phase-0-design-system-build.md`.
- ✅ **Phase 1 brief drafted** (2026-05-10) — `docs/agent-briefs/v1/` with README / inputs / tasks (39 numbered tasks across 9 groups) / discipline / handoff. Ready for user review before handing off to a builder agent.

## Blocked / open issues

- ⚠️ **Light-theme contrast gap.** `text.inverted` on `accent.primary` measures 2.93:1 in light mode (WCAG AA needs ≥ 4.5:1 for body text). Recorded in tests as a regression baseline so the failure is visible. Resolution options live with design — pick one before any light-theme user-facing surface ships:
  - Darken `accent.primary` in light mode.
  - Recolour `text.inverted` to a darker neutral.
  - Restrict accent-on-accent text to large-display-only (which only needs 3:1).

## Parked / Future

- Phase 3 — Self-Drive CLI + Rich Content (depends on 1, 2)
- Phase 4 — Quick Actions + Dashboards (depends on 2, 3)
- Phase 5 — Git + Automations + MCP Manager
- Phase 6 — Voice + Ideas Inbox
- Phase 7 — Polish + Beta
- Post-v0 deferrals — see [`future-scope.md`](future-scope.md).

---

## How this file works

- **Now** — active work; keep to 2–3 items.
- **Next** — ready to pick up when Now clears. Ordered by dependency.
- **Done** — last 3–5 completions for context. Older history lives in `docs/plan.md` per-phase `Status as of …` lines and in thoughts session files.
- **Blocked / open issues** — anything preventing progress or needing a decision.
- **Parked / Future** — planned but not in active sequence.

Update by hand when starting or finishing a phase or major task. `docs/plan.md` carries the formal per-phase status lines (the canonical record); this file is the human-readable dashboard. When in doubt, `plan.md` wins.
