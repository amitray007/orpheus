# Orpheus

A closed-source Mac IDE built around Claude Code.

## Repository layout

```
orpheus/
├── apps/                  # macOS app targets (added in Phase 1+)
│   └── Orpheus/           # Main app — AppKit + SwiftUI shell (TBD)
├── packages/              # Local Swift Packages
│   └── OrpheusDesign/     # Phase 0 — design system (tokens + components)
├── docs/                  # Specs, plans, wireframes, agent briefs, work queue
└── README.md
```

Future siblings under `packages/`: `OrpheusCore` (registry, persistence, daemon), `OrpheusTerminal` (libghostty bindings), `OrpheusVoice` (voice pipeline). All arrive as their phases ship — see [`docs/plan.md`](docs/plan.md) for the phased buildout.

## Architecture, principles, and phase plan

Full project documentation lives in [`docs/`](docs/) — start with [`docs/README.md`](docs/README.md) for the index. Highlights:

```
docs/
├── README.md             # index of everything below
├── queue.md              # work queue: Now / Next / Done / Blocked / Parked
├── specs/
│   ├── architecture.md            # LOCKED — 8-layer Swift stack
│   ├── design-principles.md       # LOCKED — tokens, materials, motion, discipline
│   └── quick-actions.md
├── plan.md               # phased delivery plan (Phase 0 → 7) with status lines
├── future-scope.md       # post-v0 deferred features
├── wireframes/
│   └── wireframes-v0.5.md         # LOCKED — 22 active surfaces
└── agent-briefs/                  # per-phase build briefs
    ├── v0/
    └── v0.5/
```

Strategic discussion + decision history lives in the second-brain repo at `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/` (the discussion log; not edited by builder agents).

Key commitments locked in [`docs/specs/`](docs/specs/):

- **AppKit + SwiftUI interop, fully native, libghostty for terminal.** No WKWebView panels.
- **Custom design system in `OrpheusDesign`.** Stock SwiftUI controls are not used in user-facing code anywhere in the app.
- **Hierarchy:** Project ▸ Space ▸ Terminal. No tabs.
- **Single language:** Swift across UI and core.

## Phase status

| Phase | Name | Status |
|---|---|---|
| 0 | Design-System Foundation (`OrpheusDesign`) | ✅ Done (2026-05-09) |
| 0.5 | Wireframes & Flows | ✅ Done (2026-04-19) |
| 1 | Core Foundation (`OrpheusCore`) | ✅ Done (2026-05-10) |
| 2+ | Feature surfaces | ⬜ Pending |

Live state lives in [`docs/queue.md`](docs/queue.md).

## Building the design system

```bash
cd packages/OrpheusDesign
swift build
swift test
swift run OrpheusDesignCatalog   # opens the design-system catalog window
```

See [`packages/OrpheusDesign/README.md`](packages/OrpheusDesign/README.md) and [`packages/OrpheusDesign/AGENTS.md`](packages/OrpheusDesign/AGENTS.md) for the design-system surface area and the discipline rules every UI module must follow.
