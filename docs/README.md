# Orpheus — Docs

Canonical home for Orpheus product specs, plans, wireframes, agent briefs, and the active work queue.

**Provenance:** these docs were originally drafted in the second-brain repo at `/Users/maverick/code/projects/thoughts/projects/orpheus/extras/` and copied here on 2026-05-09 once the project moved into active building. Going forward, edits happen **here**. The thoughts repo retains the discussion log at `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/`.

---

## Index

### Active work
- [`queue.md`](queue.md) — at-a-glance dashboard: Now / Next / Done / Blocked / Parked. Updated by hand when phases or major tasks change state.

### Specs
- [`specs/architecture.md`](specs/architecture.md) — **LOCKED.** Technical stack: AppKit + SwiftUI interop, libghostty, Swift core, JSON + SQLite/GRDB+FTS5, unix socket + JSON-RPC self-drive CLI, AVFoundation voice. 8-layer architecture with `OrpheusDesign` Swift Package as the design layer.
- [`specs/design-principles.md`](specs/design-principles.md) — **LOCKED.** All design tokens (color, typography, materials, motion, spacing, iconography). Dark + light palettes at v0 starter values. 8 discipline rules including "never stock SwiftUI controls."
- [`specs/quick-actions.md`](specs/quick-actions.md) — Behavior spec for the Quick Actions footer strip (W4). Three execution modes: orchestration / inject / hybrid.

### Plans
- [`plan.md`](plan.md) — v0 phased buildout. 9 phases, ~75–85 tasks, dependency-ordered. Per-phase `Status as of YYYY-MM-DD` lines record completion.
- [`future-scope.md`](future-scope.md) — Post-v0 deferred features (extensions browser, Git surfaces, automations, ideas inbox, notifications, voice variants, etc.).

### Wireframes
- [`wireframes/wireframes-v0.5.md`](wireframes/wireframes-v0.5.md) — **LOCKED.** 22 active v0 wireframes + 4 archived post-v0. ASCII markdown source format. 1,746 lines.

### Agent briefs
- [`agent-briefs/v0/`](agent-briefs/v0/) — **Phase 0** (Design-System Foundation, `OrpheusDesign` Swift Package). 5 files: `README`, `inputs`, `tasks`, `discipline`, `handoff`. Phase 0 ✅ done as of 2026-05-09.
- [`agent-briefs/v0.5/`](agent-briefs/v0.5/) — **Phase 0.5** (Wireframes & Flows) reference + `lore.md`. Phase 0.5 ✅ done as of 2026-04-19.

---

## How sessions and decisions are tracked

- **Spec / plan / wireframe / brief edits** → in `docs/`, here.
- **Live work-queue updates** → `docs/queue.md`.
- **Strategic discussions, decisions, retrospectives** → thoughts repo, as session files. Run `/continue orpheus` from there to start one.
- **Phase reports** (e.g. "Phase 0 complete", "blocked on X") → builder agents write these as session files in the thoughts repo per `docs/agent-briefs/<vN>/handoff.md`.

## Path conventions

- `docs/specs/...`, `docs/plan.md`, `docs/agent-briefs/...` etc. — repo-rooted paths within this code repo.
- `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/...` — absolute paths to thoughts-repo session files (the discussion log).
