# Orpheus — Future Scope

Living document of decisions explicitly **deferred beyond v0 / outside current phases**. Each entry is a signal to future-us that a capability was considered, scoped, and consciously set aside — not forgotten.

**Maintenance rules:**
- Any time the ongoing design discussion moves something to "later" / "v1+" / "someday," add it here.
- Each entry records: what, why deferred, trigger to revisit, and cross-refs to the session where the decision happened.
- Sorted by category for scannability. Add new categories as they emerge.
- Date each addition so we can see the evolution of the deferred pile.


NOTE: THIS DOC IS NOT UP TO DATE. It captures old plans and specs and architectural considerations that have since evolved. It's a historical artifact of the early design process, not a reflection of current thinking. Use it for context on how we got here, but refer to the latest sessions for the current state of future-scope decisions.

---

## Cross-platform + portability

### Linux / Windows support
**Added:** 2026-04-18 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-0121-decide-architecture-native-stack.md`
**What:** Orpheus on Linux and Windows.
**Why deferred:** Mac-first is the stated priority; SwiftUI/AppKit/libghostty stack is Mac-only. Cross-platform would require either rewriting the UI layer in Tauri or porting the core to Rust + native shells per platform.
**Trigger to revisit:** Orpheus has meaningful daily-driver adoption on Mac AND users are asking for Linux/Windows. Or: a decision to open-source (future-scope too) that changes the calculus.
**Design hint:** keep `OrpheusCore` modules free of Mac-only APIs where feasible; `OrpheusTerminal`, `OrpheusVoice`, and the shell are Mac-specific. A port would rebuild UI + terminal + voice per-platform, reusing core logic.

### ACP / multi-agent portability
**Added:** 2026-04-18 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-0121-decide-architecture-native-stack.md`
**What:** Speak the Agent Client Protocol so Orpheus works with any ACP-compliant agent (Codex, Gemini CLI, OpenHands, Cline, etc.), not just Claude Code.
**Why deferred:** CC-only for v0 is explicit; ACP portability dilutes focus. ACP doesn't cover CC-specific features (hooks, channels, remote-control, agent-teams) anyway, so there'd be a CC-depth path plus an ACP-floor path.
**Trigger to revisit:** v0 is stable and user finds value in using agents other than CC; or a partner opportunity that demands multi-agent support.

### Daemon mode + mobile/web clients
**Added:** 2026-04-18 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-0121-decide-architecture-native-stack.md`
**What:** Rearchitect the Swift core into a daemon (or extract Rust core) that mobile + web clients connect to over WebSocket. Paseo-style cross-device.
**Why deferred:** Single-user, single-machine is the v0 scope. Daemon architecture adds real complexity for a use-case that doesn't yet exist.
**Trigger to revisit:** user actively wants to steer Orpheus from a phone while away from the desk AND single-machine daily-driver is proven.

### Orpheus-as-brand additional agentic layers
**Added:** 2026-04-16 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-16-2339-brainstorm-ide-concept-reframe.md`
**What:** Orpheus as an IDE brand hosting multiple agentic-tool layers beyond the first Claude Code integration. Future layers could be: custom agent frameworks, other coding-agent backends, non-coding agentic tools (research, writing, content).
**Why deferred:** v0 ships one layer (Claude Code). Brand-level multi-layer design requires the first layer to be solid first.
**Trigger to revisit:** v0 Claude Code layer is shipped, stable, and user wants to add a new kind of layer (e.g., a research-agent layer) on top.

---

## Space-level features

### Auto-generated space metadata (name + description)
**Added:** 2026-04-18 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-1705-refine-simplify-space-hierarchy.md` (this session)
**What:** Automatic generation + updating of space name and description based on discussions/chats inside the space's sessions. Space "personality" emerges from activity.
**Why deferred:** Too much to build before a working product exists. LLM calls, rate-limiting, user-override logic, privacy concerns, cost control. Better to ship the product first and layer this on once we have real usage data.
**Trigger to revisit:** v0 shipped; user has multiple active spaces and is manually naming/describing them; we have signal that auto-gen would save real time.
**When re-designing:** consider keyframe updates (not continuous), user-override locks, opt-out per space, Haiku-class model for cost control, privacy opt-out for sensitive work.

### Per-space configuration overrides
**Added:** 2026-04-18 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-1705-refine-simplify-space-hierarchy.md` (this session)
**What:** Let spaces override project settings — per-space MCP servers, per-space skills, per-space quick actions, per-space default model / effort level.
**Why deferred:** v0 keeps config at global + project levels. Adding a third level (space) is more surface area than the first v0 usage warrants.
**Trigger to revisit:** user actively wants different tools in different spaces (e.g., "this space has the DB MCP, that space doesn't").

### Worktree-per-space isolation option
**Added:** 2026-04-18 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-1705-refine-simplify-space-hierarchy.md` (this session)
**What:** Allow a space to optionally run in its own git worktree. Terminals inside that space share a dedicated worktree; changes don't affect other spaces in the same project.
**Why deferred:** Adds complexity around worktree lifecycle, filesystem state, per-space cwd management. User acknowledged the restrictions this introduces. Worktree-per-session (v0, via `--worktree` flag passed to `claude`) covers the primary isolation need.
**Trigger to revisit:** user is regularly working on parallel branches within the same project and wants them in separate spaces.

### Auto-suggest archive for inactive spaces
**Added:** 2026-04-18 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-1705-refine-simplify-space-hierarchy.md` (this session)
**What:** After N days of space inactivity, Orpheus suggests archiving.
**Why deferred:** v0 lets user decide when to archive. Heuristic auto-suggestion is a nice-to-have polish feature.
**Trigger to revisit:** user accumulates many stale spaces and manually managing archive becomes friction.

### Manual override of auto-generated metadata (lock / re-enable auto)
**Added:** 2026-04-18 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-1705-refine-simplify-space-hierarchy.md` (this session)
**What:** When user edits a space name or description manually, lock it from auto-updates. One-click "re-enable auto" to resume.
**Why deferred:** Depends on auto-generation (itself future-scope). Build together when auto-gen ships.
**Trigger to revisit:** when auto-generation ships.

### Space personality enhancements
**Added:** 2026-04-18 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-1705-refine-simplify-space-hierarchy.md` (this session)
**What:** Extra per-space identity: accent tint (subtle color variation in sidebar), emoji/icon, custom Claude system-prompt addendum (space-awareness), pinned /Users/maverick/code/projects/thoughts/projects/orpheus/sessions/files for fast access, space-scoped scratchpad/notes.
**Why deferred:** v0 keeps spaces minimal (name + layout + terminals). These enhancements are polish + differentiation once core works.
**Trigger to revisit:** v0 shipped, users heavily using multiple spaces, and we want to make switching between them more visceral.

---

## MCP / Skills / Knowledge base management

### Install / edit / manage MCPs + Skills + KB from inside Orpheus
**Added:** 2026-04-18 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-0121-plan-v0-phased-buildout.md`
**What:** v0 Phase 5 ships browse-only for MCPs / Skills / KB. Future: add install, edit, manage, delete flows.
**Why deferred:** Browse-only is enough for daily-driver observability; full management is a separate surface.
**Trigger to revisit:** users asking to manage inventory without dropping to CLI.

---

## Theme + identity

### Theme customizability (user-defined themes)
**Added:** 2026-04-18 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-0401-decide-phase-zero-design-foundation.md`
**What:** Let users define custom themes — accent color, palette, typography pair, even material tuning. Ship with Lyre Gold as default + 1-2 alternates (e.g., Pomegranate, Amber CRT) user can swap to.
**Why deferred:** v0 locks one theme (Lyre Gold + warm-subtle palette). User-theming needs a stable token system and a theme-loading UI; both post-v0.
**Trigger to revisit:** v0 shipped; users asking to swap aesthetics; or Orpheus goes multi-user and people want variety.

### Commissioned custom typeface pair
**Added:** 2026-04-18 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-0401-decide-phase-zero-design-foundation.md`
**What:** Follow Cursor's lead — commission a custom typeface family (mono + sans) tuned for Orpheus. Kimera-style deep identity work.
**Why deferred:** $10k–$50k commissioned work is premature for a v0. Satoshi + Commit Mono is the v0 starter pair.
**Trigger to revisit:** product-market fit signals; brand identity refresh moment; budget allocated for a proper design refresh.

---

## Multi-user / team

### Multi-user / team features
**Added:** 2026-04-18 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-0121-decide-architecture-native-stack.md`
**What:** Multi-user support — shared spaces, team-scoped MCPs/skills, permissions, collaborative sessions.
**Why deferred:** Orpheus is explicitly single-user daily-driver for v0. Team features are a different product shape.
**Trigger to revisit:** monetization model emerges that suggests team use; organic demand from users working in teams.

---

## Post-launch feature wireframes

Wireframes drafted and preserved in `docs/wireframes/wireframes-v0.5.md` but **not in v0 scope**. Focus for launch is the base product + a handful of core features; these land after.

### Extensions browser — MCP / Skills / KB (Wireframe 22)
**Added:** 2026-04-19 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-19-0421-refine-wireframes-v0-5-iteration-11-final-six-surfaces.md`
**What:** In-app browser for installing, enabling, disabling, and configuring MCP servers, Claude Code skills, and knowledge-base sources. 3-tab pattern (MCP / Skills / KB) + list/detail split; scope radio (Global vs per-project); Install/Uninstall flows.
**Why deferred:** MCP/Skills/KB management is a power-user surface. v0 launch aims for the base experience — managing extensions via Orpheus is a "comes after" capability once the base is solid. Orpheus still honors Claude Code's own MCP + Skills support in v0 (CC's native flows work).
**Trigger to revisit:** base v0 shipped; users ask for in-app management; new MCP/Skills/KB that benefit from per-project scope rather than global install.
**Design preserved in:** W22 (marked 📦 archived).

### Git surfaces — PRs / Issues / Actions / Branches (Wireframe 23)
**Added:** 2026-04-19 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-19-0421-refine-wireframes-v0-5-iteration-11-final-six-surfaces.md`
**What:** In-app Git/GitHub surface — list PRs, issues, Actions runs, and branches per project. Detail pane with PR metadata, checks, actions. Novel affordance: `[ Ask Claude ]` spawns a Claude session preloaded with PR context for quick review.
**Why deferred:** Git integration is high-value but requires solid GitHub-API plumbing, auth, multi-repo handling, and PR-review UX — substantial scope for a launch. v0 users can still shell to `gh` CLI from any terminal; native Git surfaces come after launch.
**Trigger to revisit:** base v0 shipped; user flow of review/merge PRs is frequent enough to justify in-app integration; partner or personal workflow demands it.
**Design preserved in:** W23 (marked 📦 archived).

### Automations — Rules / Schedule / Running (Wireframe 24)
**Added:** 2026-04-19 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-19-0421-refine-wireframes-v0-5-iteration-11-final-six-surfaces.md`
**What:** Kickstart-inspired rule engine — event triggers (process, session, git, file watcher), time triggers (cron), manual triggers. Rules UI (list + detail), schedule view (timeline), live running view.
**Why deferred:** Automations is a cornerstone future feature but layering it on top of an unproven base product is premature. Simple automations can be scripted externally for now; bring it in-app once there's user clarity on the most common rule patterns.
**Trigger to revisit:** base v0 shipped; recurring "I wish Orpheus would auto-X when Y" feedback emerges; Phase 5+ roadmap.
**Design preserved in:** W24 (marked 📦 archived).

### Ideas Inbox — capture + scaffold (Wireframe 25)
**Added:** 2026-04-19 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-19-0421-refine-wireframes-v0-5-iteration-11-final-six-surfaces.md`
**What:** Lightweight ambient-capture surface for "I had a thought" moments. Quick capture via `⌘Shift+I`; list of captured ideas; scaffold action promotes an idea to a new project (creates project + Default Space + brainstorm-seeded Claude session).
**Why deferred:** User-delight feature but not blocking for launch. External tools (Apple Notes, Things, etc.) fill this need today; bringing it into Orpheus is "nice to have" until the core tool is proven.
**Trigger to revisit:** base v0 shipped; user flow of "I want to capture an idea without losing focus" is common enough to justify the in-app surface.
**Design preserved in:** W25 (marked 📦 archived).

---

## Notifications

### macOS native notifications
**Added:** 2026-04-19 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-19-0325-refine-wireframes-v0-5-iteration-8-menubar-tabs-and-delete.md` (flagged in iteration 10 review)
**What:** Use macOS's `UserNotifications` framework to post native banners/alerts for events users want to be paged on — long-running Claude turn completed, dev server crashed, automation triggered (matched a kickstart-style rule), permission prompt needed from a tool-use, background task finished, session interrupted, etc. Delivery options: banner, alert, sound, badge on the dock icon + menu bar icon. Respects user's Focus/Do-Not-Disturb.
**Why deferred:** v0 focuses on the in-app surfaces (main window chat, menubar dropdown, error toasts/banners); the menubar already surfaces live state. Native notifications add another channel and need per-event policy (which events notify, when, how noisily) plus user prefs — worth doing right, not rushing.
**Trigger to revisit:** v0 users report missing important events because they were in a different app; or the automations feature lands (Phase 5) and needs a cross-app "this ran" signal; or voice-loop users want alerts when Claude finishes while they've tabbed away.
**Design hints for later:**
- Per-event-type toggle in Settings → Notifications (granular — don't just have an on/off).
- Integrate with the in-app error toast/banner pattern (W19) — notification is the out-of-app variant of the same event.
- Menu bar icon badge count for unacknowledged notifications.
- Respect macOS Focus modes and user's notification preferences (don't force noisy alerts).

---

## Extension hooks (not now, but design-aware)

### WKWebView escape hatch for rich content
**Added:** 2026-04-18 · `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-0121-decide-architecture-native-stack.md`
**What:** If a specific rich-content surface (most likely syntax highlighting) hits an unresolvable wall in native SwiftUI, a single `WKWebView` for that one surface is a documented escape hatch.
**Why deferred:** v0 commits to fully native. Escape hatch is documented for completeness; not planned.
**Trigger to revisit:** a specific native implementation (most likely TextKit 2 + SwiftTreeSitter for syntax highlighting) doesn't reach required quality after fair effort.

---

## Maintenance log

- **2026-04-18:** Initial version. Populated with deferred items from all prior sessions (2026-04-16 through 2026-04-18) plus today's space-hierarchy simplification session.
- **2026-04-19:** Added **Notifications** category (macOS native notifications) after iteration 10 review flagged them as a later surface.
- **2026-04-19:** Added **Post-launch feature wireframes** category after iteration 12 archived W22 (Extensions browser), W23 (Git surfaces), W24 (Automations), and W25 (Ideas Inbox) to focus v0 on the base product + core features.
