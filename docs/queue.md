# Queue

_Last updated: 2026-05-10 IST_

## Now

- Phase 2A — libghostty FFI. Standalone `OrpheusTerminal` Swift Package wrapping libghostty's C API. Test executable opens a window, embeds a terminal, spawns a shell, takes input, renders output. Smallest sub-phase but riskiest — if the binding strategy doesn't work, everything else in Phase 2 stalls. Brief to draft at `docs/agent-briefs/v2a/`.

## Next

- Phase 2B — app shell + sidebar (W1, W2, W3, W18, W19). Orpheus.app target with main window chrome, sidebar populated from `OrpheusCore`'s `ProjectRepository`/`SpaceRepository`/`TerminalRepository` observers, onboarding flow, empty/loading/error states. No terminal hosting yet — that lands in 2C.
- Phase 2C — terminal hosting + splits + auto-restore (W6, W7, W8, W10, W11). `OrpheusTerminalView` wrapping 2A's bindings. H/V splits per space. New-project + new-space modals. Auto-restore on launch from `OrpheusCore` persistence; force-close survival.
- Phase 2D — canvas + drag polish (W17). Free-arranged terminals, terminal-drag UX across splits, final wireframe-fidelity touches. Can slip to Phase 7 if tight.
- Phase 3 build — Self-Drive CLI + Rich Content. Adds the chat viewer (W4), diff viewer (W21), code viewer with syntax highlighting. Depends on Phase 1 (core) + Phase 2 (terminal host).

## Done

- ✅ **Phase 1 — Core Foundation, `OrpheusCore`** (2026-05-10) — Swift Package shipped at `packages/OrpheusCore/`. Headless data + plumbing: typed model, GRDB persistence with FTS5, settings loader/merger/hot-reload, session registry + JSONL watcher, subprocess manager, smoke executable. 291 tests passing (2 documented skips), 0 failures. Review session: `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-05-10-0654-review-phase-1-core-foundation-build.md`.
- ✅ **Phase 0.5 — Wireframes & Flows** (2026-04-19) — 22 active v0 wireframes locked across 13 iterations + 4 archived post-v0. See `docs/wireframes/wireframes-v0.5.md` and `docs/agent-briefs/v0.5/lore.md`.
- ✅ **Phase 0 — Design-System Foundation, `OrpheusDesign`** (2026-05-09) — Swift Package shipped at `packages/OrpheusDesign/` with all token categories, 22 components, dark + light themes, and `OrpheusDesignCatalog` preview app. 84 tests, all gates green. Review session: `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-05-09-2128-review-phase-0-design-system-build.md`.

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
