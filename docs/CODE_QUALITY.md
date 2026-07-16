# Code quality review checklist

This is the checklist for a code-quality *review* pass (human or agent) —
distinct from the automated gates. It exists so a future review has the same
rigor as `docs/audits/2026-07-02-code-quality-audit.md`, whose findings ARE
these dimensions applied once. Read that doc as the worked example.

## How to use this

1. **Run the automated gates first — they're the floor, not the review.**
   `bun run check` (typecheck + lint + `check:dup` + `check:arch`) and
   `bun run test:db` (if `src/main/db/**` changed). Don't hand-check anything
   a gate already covers.
2. **Then work the 10 dimensions below.** These are the things `check:dup`
   (jscpd), `check:dead` (knip), `check:arch` (dependency-cruiser), and
   typecheck/lint structurally *cannot* see.
3. **The biggest gate blind spots are dimension 3 (semantic duplication),
   dimension 5 (swallowed errors), and dimension 9 (races).** Gates find
   token-identical code and type errors; they cannot tell you two functions
   do the same thing differently, that a catch block is hiding a real
   failure, or that two awaits can interleave badly. Reason about these
   explicitly — don't rely on tooling to surface them.
4. **Findings that change runtime behavior need a dev-build test.** There is
   no general test runner (`test:db` covers only the migration engine). Use
   `bun run build:unpack` and drive the actual interleaving/UI path before
   marking a race or a UI fix "done" rather than "built (unverified)".
5. **This can be run as parallel per-dimension read-only agents** — one agent
   per dimension below, each producing findings with file:line evidence. That
   is how the source audit was produced.

---

### 1. Actively broken / costing now

- Is anything failing or erroring right now — a red gate, a broken build,
  a start-up crash?
- Is there a hot-path log or warning that fires unbounded (every event, every
  poll tick) instead of once or deduped?
- Is there a resource (timer, `NSActivity`-style OS assertion, subprocess)
  acquired once and never released, running for the life of the process?
- Is a "dormant"/"legacy" code path actually still executing on every
  request even though its output is discarded?

### 2. CI, automation & quality gates

- Is new code's directory/file-type actually covered by the gates, or does
  it fall into an ignore pattern (e.g. lint's `docs/**` ignore) unintentionally?
- Is a gate wired against a target that moved or was deleted (a paths-filter,
  a script path) — silently a no-op?
- Is a new async/IPC/promise-heavy area covered by the type-aware lint tier,
  or does it land somewhere still on `recommended` (non-type-checked)?
- Are new secrets-adjacent paths (workflows, release scripts) covered by
  dependency/security scanning, and are third-party actions pinned?

### 3. Duplication, dead code, structure

- **Token duplication** (jscpd catches this) — skip it, that's the gate's job.
- **Semantic duplication** (gates MISS this): two functions/components/stores
  doing the same thing with different code — "should this be abstracted?"
  Look for parallel modules with near-identical shape (e.g. a `project` vs
  `workspace` settings store that's a 110-line zero-diff twin), or N copies
  of a load/patch/reconcile scaffold across sibling components. An
  embedding-based similarity tool (slopo, similarity-ts) can surface these
  in a manual pass where jscpd's token-matching won't.
- **God files/components** — a file with a large handler count or a
  component with double-digit `useState`/`useEffect` and dozens of props
  doing routing + state + IPC all at once.
- **Dead exports** (knip catches unused imports, but verify the "needs-care"
  bucket — symbols that look dead but are referenced dynamically/by string).
- **Type-safety leaks** — `any`, `as`/`as unknown as` casts, especially at
  a boundary (IPC, DB row → typed record, external JSON) where they erase
  the one place type safety would matter most.

### 4. Performance

- Sync I/O (`readFileSync`, `execFileSync`) on the main/UI thread, especially
  inside a hot path (a debounce tick, a per-request handler) rather than a
  one-time cold path.
- Unbounded caches/Maps that are populated but never evicted, especially
  keyed per-entity (per-workspace, per-session) with no teardown hook.
- N+1 patterns: work fanned out once per client/consumer of a shared resource
  when it could be computed once and shared.
- Watchers, intervals, or polling loops with a fixed short period and no
  backoff when idle, and no cleanup path when the thing they watch goes away.
- Whole-file reads (e.g. `JSON.parse` over an entire multi-MB transcript)
  where a bounded/chunked/streaming read would do.

### 5. Error handling & robustness

- **Swallowed errors** — an empty `catch {}` or `.catch(() => {})`/
  `.catch(console.error)` where the failure has real consequences (a status
  write that silently no-ops, freezing a workspace's displayed state).
  Gates can't see a silently-swallowed failure — this needs a human/agent
  reading catch bodies with "what does the user see if this throws?" in mind.
- **Console-only logging** for a real failure — invisible in a packaged app,
  absent from any diagnostics/export path.
- **Missing user-visible error surface** — a failed action (mount, archive,
  rename) that leaves the UI in a silently-broken state with nothing shown.
- **Missing crash/startup-failure handling** — an unhandled promise rejection
  or thrown error during boot that leaves no window and no log.
- **Un-narrowed error/external-data shapes** — external JSON (a session file,
  an IPC payload) cast without a runtime check, so a shape change becomes a
  silent `NaN`/`undefined` downstream instead of a loud failure.

### 6. Open-source readiness / docs

- Do the docs (README, CONTRIBUTING, LICENSE, SECURITY) match what the code
  and distribution model actually do today, or are they describing a past
  state (private repo, different install channel)?
- Is the license grant compatible with how the product is actually shipped?
- Is there missing contributor-facing guidance (install steps, conventions)
  that a new contributor would need and can't infer from code alone?
- Any secrets, tokens, or personal machine paths in tracked files (grep for
  `/Users/<name>`, API-key-shaped strings, etc.)?

### 7. React & renderer patterns

- **Stale snapshot state** — a `.get()`-once-on-mount with no subscription
  to the corresponding `onChanged`/push event, so a later external write
  never re-renders the component holding it (the classic "toggle does
  nothing until relaunch" bug).
- Copy-pasted stores/hooks with the same ~40-line `Map` + listeners +
  `useSyncExternalStore` shape repeated per key, diverging in easy-to-desync
  details (equality check, eviction).
- Effect misuse: a computed/joined string smuggled into a deps array to
  dodge `exhaustive-deps`, or a value read in the effect body but missing
  from deps (silently never re-runs on that value's change).
- Missing memoization / prop-drilling depth that defeats memoization (a
  value passed through 3+ components only to be used in a `.find()` at the
  leaf).
- A11y: focus traps and initial focus on modals/dialogs, `role`/`aria-*` on
  custom interactive elements, and list keys — array-index keys on
  reorderable or deletable rows will misattribute focus/state after a
  delete.

### 8. Conventions, naming, comments

- **Lying/stale comments** — a comment describing a state ("Phase 1",
  "used until X lands", "the only theme available") that the code has since
  moved past. These actively mislead the next reader/agent more than no
  comment at all.
- Inconsistent naming for one concept across the codebase — two near-
  identical functions (`getX`/`getXById`) with no real semantic difference,
  or a singular/plural split in one namespace of otherwise-consistent names.
- Undocumented units on numeric fields (is this milliseconds, minutes,
  seconds? epoch or duration?) — especially in a shared types file read by
  both processes.
- Grab-bag modules: a file whose exports span unrelated concerns (status
  dispatch + watchdogs + socket server in one file) versus small
  single-concern modules elsewhere in the same codebase — inconsistency is
  the tell, not size alone.

### 9. Async correctness & races

These are the class gates and typecheck **cannot** catch — they require
reasoning about interleavings, not static analysis, and often need a running
dev build to actually observe.

- **Interleaving after an await**: code captures some state, awaits
  something slow, then acts on the captured state as if it's still valid —
  e.g. a mount handler that fetches a workspace, awaits a multi-second
  reconcile, and only then acts, without re-checking the workspace still
  exists (the archive-during-mount case that resurrects a deleted worktree
  and spawns a zombie process).
- **Stale-response overwrite**: two async operations for the same logical
  slot (a search, a list fetch) where the slower one's result can land after
  and clobber the faster/newer one's result, with no request-id/generation
  guard.
- **Missing mutexes** on an operation that must be serialized per key (two
  concurrent writes to the same terminal/workspace interleaving instead of
  queuing).
- **Floating promises with ordering significance** — an un-awaited,
  uncaught promise where the *order* of its effects relative to the caller's
  next steps matters (not just "nobody awaited it," but "and that's
  observably wrong").
- **Teardown races** — a resource registered by an async setup path that
  completes *after* the corresponding teardown already ran, so the teardown
  "succeeds" against a resource that doesn't exist yet, and the resource
  leaks once setup finally finishes.

### 10. Main-process & DB craftsmanship

- **SQL safety**: every dynamic fragment whitelist-derived and every value
  bound (no string-interpolated user input); `LIKE` queries escape user-typed
  `%`/`_` wildcards.
- **Schema hygiene**: consistent column typing conventions (e.g. boolean
  columns all using the same `CHECK` pattern), foreign keys indexed the same
  way as their siblings, no state duplicated across two columns/an enum value
  that has to be hand-synced (a recurring source of "frozen" bugs).
- **Function complexity**: a single function doing auth + parsing + business
  logic for what should be several handlers (duplicated security plumbing is
  especially worth flagging — a fix to one copy that isn't mirrored to the
  other is a live vulnerability class).
- **Module boundaries / circular deps**: verify with the arch gate, but also
  look for functions logically owned by module A living in module B "because
  that's where the caller happened to be."
- **Magic-value duplication**: the same default/threshold/path-composition
  logic recomputed independently in multiple files (e.g. two independent
  slug/path-encoding implementations that could silently drift).
- **IPC contract drift**: parameter shapes and error-response conventions
  consistent across the surface (not four different "not found" / error
  styles that every caller has to special-case).
