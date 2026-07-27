# Agentic Control Plane Roadmap

**Status:** Phases 1–8 implemented; the current integration batch
live-validated Phase 3 background open, Phase 4 controls, Phase 5 exact scoped
pane observation, Phase 6 reads/patch, and Phase 7–8 automation recovery<br>
**Companion documents:** [README.md](README.md),
[architecture.md](architecture.md),
[identity-and-permissions.md](identity-and-permissions.md),
[Phase 1](phase-01-control-foundation.md), and
[Phase 2](phase-02-self-identity-readonly-mcp.md);
[Phase 3 contract](phase-03-workspace-orchestration.md) and
[Phase 3 interfaces](phase-03-interfaces.md);
[Phase 4 contract](phase-04-workbench-pane-control.md) and
[Phase 4 interfaces](phase-04-interfaces.md);
[Phase 5](phase-05-terminal-observability.md);
[Phase 6 contract](phase-06-settings-resources.md) and
[Phase 6 interfaces](phase-06-interfaces.md);
[Phase 7](phase-07-durable-automations.md)

This roadmap delivers the Agentic Control Plane as eight additive, independently
reviewable phases. Each phase has a narrow contract, explicit exclusions, and a
standalone acceptance boundary. A phase may depend on the stable contracts from
an earlier phase, but it must not bundle unfinished work from the next phase.

The existing `orpheus` CLI remains supported throughout. Its commands, JSON
output, exit codes, command-socket behavior, auto-launch rules, and direct
SQLite/JSONL offline reads are compatibility contracts. The roadmap does not
replace, rewrite, or remove them.

Completion is based on shared semantics and adapter parity, not deletion of
existing CLI, IPC, Quick Actions, or command-socket surfaces.

## Delivery rules

Every phase:

- lands as its own reviewable change with a bounded file and behavior surface;
- preserves the current app and CLI behavior unless its scope explicitly adds a
  new capability;
- distinguishes public capability contracts from adapter-specific envelopes;
- adds tests or a deterministic verification harness for its new contract;
- documents what was verified statically and what still needs live/manual
  validation;
- uses the declarative migration engine in `src/main/db/` for any persistence;
- keeps secrets out of agent-readable descriptors, results, and logs;
- keeps cache-only observations separate from refresh/probe operations whose
  declared effects can include process inspection, credential access, network
  requests, process spawning, and cache writes;
- can be rolled back without migrating user data backward.

## Phase summary

| Phase                            | Delivery status                   | Outcome                                                                                         | Primary review boundary                                   |
| -------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1. Control Foundation            | Implemented and statically tested | Add a transport-neutral capability registry and prove it with the two review-comment operations | Registry contract plus preserved IPC/socket adapters      |
| 2. Self Identity + Read-only MCP | Implemented and live-validated    | Ship managed MCP discovery with identity and read-only tools                                    | MCP bootstrap, contextual tool filtering, read schemas    |
| 3. Workspace Orchestration       | Implemented; background open and terminal color live-reconfirmed, three focused paths pending | Add semantic workspace creation, task start, wait, and lifecycle control | One orchestration service, strict schemas, archive safety |
| 4. Self Workbench/Panes Control  | Implemented; core live controls validated, negative live paths pending | Let an agent control its own workbench and panes semantically | Self-scoped UI commands, no click simulation              |
| 5. Terminal Observability        | Implemented; scoped-pane repair rebuilt and live-validated | Add authoritative terminal/session observation | Source/freshness contract and explicit absence states |
| 6. Settings/Resources            | Implemented; core live reads/patch validated, restart-required path pending | Expose allowlisted non-secret settings and resources                              | Layering, validation, dirty-state, and secret boundaries  |
| 7. Durable Automations           | Implemented; packaged schedule/event/recovery/cleanup validated | Persist bounded triggers, internal-event outbox, and runs that invoke semantic operations | Scheduler, crash recovery, idempotency, budgets, retries  |
| 8. Integrated Validation         | Deterministic suite, exact-source rebuild, and major packaged paths complete; residual limitations recorded | Prove parity, recovery, policy, and compatibility across all adapters | Cross-surface contract and live validation matrix         |

## 1. Control Foundation

Add the canonical transport-neutral registry, invocation context, validation,
stable results, and adapter mapping. Use `reviews.list` and
`reviews.setResolved` as the proof slice because they already exist through both
renderer IPC and the CLI command socket.

Review this phase without MCP, new public actions, schema migration, or CLI
changes. Existing `reviews:list`, `reviews:setResolved`, and `/cmd` envelopes
must be behaviorally unchanged. `actions:list` must not expose the new
capabilities yet.

Exit when both existing adapters delegate to one registered handler per proof
capability and static tests demonstrate validation, context flow, success, and
stable error mapping. See
[phase-01-control-foundation.md](phase-01-control-foundation.md).

## 2. Self Identity + Read-only MCP

The implementation bundles an Orpheus MCP stdio adapter into managed Claude
launches through an ephemeral launch-time `--mcp-config` that does not mutate
user/global `.mcp.json`. It generates `tools/list` from the canonical catalog,
filtered by the main-resolved runtime lease and read-only grants.

Initial capabilities:

- `self.get` authorized by `identity.read`;
- project reads authorized by `projects.read`;
- workspace metadata, activity/status, and transcript/last-turn reads
  authorized by `workspaces.read`;
- review reads authorized by `reviews.read`;
- control-plane operation description/version.

Main creates an immutable runtime binding and runtime-scoped bearer lease for
the managed adapter. The current app-global same-user command token and
caller-supplied ambient workspace context remain compatibility inputs, not
runtime authentication. This phase does not expose mutations.

The existing Home dashboard's account-wide GitHub snapshot, provider-neutral
usage, all-history Claude activity windows, GitHub contribution windows,
persisted cache, and background push channels are typed renderer compatibility
surfaces and future catalog migration inputs. Phase 2 does not publish them.
Before later publication, cached snapshot reads and active refresh/probe
operations receive separate schemas and permissions, with explicit
account/app-global scope and declared effects. Home tab selection and
refresh-button clicks remain renderer presentation details.

Exit when a fresh managed workspace discovers the read tools without prompt
instructions or manual configuration, schemas match the catalog, reads identify
their source/freshness, and a caller cannot discover another project's
restricted data.

The code, deterministic checks, and live acceptance pass are complete. A fresh
managed workspace eventually discovered all nine tools without manual
configuration; live calls confirmed exact bound identity, non-enumerating
cross-project denial, and retained identity after hide/reattach. Claude 2.1.220
starts MCP servers asynchronously, so the first `/mcp` snapshot can omit the
still-pending server; this does not change the completed exit criterion. See
[phase-02-self-identity-readonly-mcp.md](phase-02-self-identity-readonly-mcp.md)
for the delivered contract, validation record, and explicitly harness-only
lifecycle checks.

## 3. Workspace Orchestration

Phase 3 publishes one `WorkspaceOrchestrationService` behind semantic
operations for workspace creation, task start, open/background activation,
send, bounded wait, close, reopen, rename, and Tier 3 archive, plus a lineage
read. Preserve existing CLI behavior while routing shared semantics through the
control core.

The core owns:

- strict runtime identity, same-project defaults, and non-enumerating
  cross-project checks;
- parent lineage and fork resolution, including fork without an initial task;
- `local` and managed `worktree` creation with server-derived cwd;
- max-depth/max-children limits;
- self-close/self-archive protection;
- readiness and bounded task injection;
- MCP waits capped at 25 seconds while retaining existing CLI durations;
- stable wait outcomes and timeout behavior;
- strict schemas with no settings overlay or arbitrary key injection;
- typed effect receipts and partial results;
- a dedicated recursively redacted control audit;
- nonrecursive child rejection and recursive whole-subtree archive preflight,
  with no MCP force option.

The compatibility boundary retains CLI envelopes, output, exit codes, offline
reads, long waits, and auto-launch. Implementation also repairs stale
token/socket cache invalidation on the intended single auto-launch retry and
makes fork-alone a valid CLI creation intent.

Review this phase as workspace-domain work only. Do not include workbench,
panes, settings, or automation.

The deterministic Phase 3 suite and full repository check pass. The packaged
live pass confirmed managed MCP `self.get`, lineage, and bounded wait behavior
with default mutation absence; CLI lifecycle, fork, archive, and redacted audit
behavior; renderer create/fork; and cleanup. The current integration batch
additionally confirmed that packaged CLI `ws open --background`, with
`ORPHEUS_DATA_VARIANT=dev`, mounted an unmounted workspace without timing out
while Home stayed visible.

The managed terminal had no ambient `NO_COLOR` or `FORCE_COLOR`, reported
`TERM=xterm-ghostty`, `COLORTERM=truecolor`, and 256-color support, and rendered
an ANSI/truecolor swatch correctly. The earlier missing color came from the QA
launcher setting ambient `NO_COLOR`, not from the CLI/control-plane changes.
The ordinary renderer close/archive acknowledgement race, explicit-name
behavior, and CLI `--no-submit` path remain deterministic-only.

Default runtime grants expose exactly 11 safe read/wait tools. Mutation
descriptors require explicit server-owned grants within their risk ceiling.
Phase 3 does not add persisted grants or a user grant UI.

See
[phase-03-workspace-orchestration.md](phase-03-workspace-orchestration.md) for
the frozen domain and acceptance contract and
[phase-03-interfaces.md](phase-03-interfaces.md) for the strict operation
schemas, permissions, tiers, effects, receipts, and stable errors.

## 4. Self Workbench/Panes Control

Expose semantic commands for the calling agent's own workspace:

- open a file or diff in the workbench;
- select a workbench tab or review target;
- select a persisted pane layout;
- start, stop, or focus a configured pane terminal;
- query current self workbench/pane state.

Implementation may send targeted renderer messages, but public capabilities
express Orpheus intent. DOM selectors, coordinates, accessibility scripting,
and generic click/key simulation are excluded. Cross-workspace UI manipulation
is excluded.

Exit when the same semantic command works regardless of renderer layout details,
is self-scoped in policy, and reports a clear unavailable result when no
renderer/window can fulfill it.

The packaged integration batch exercised Workbench/pane state, tab selection,
file/diff open, layout selection, and pane start/focus/stop through managed MCP,
exact scope, and real renderer acknowledgements. Completed mutations included
correlated request/audit ids and applied effect receipts. Forced renderer loss
and unavailable/partial live paths remain deterministic-only.

## 5. Terminal Observability

Expose authoritative observation for Claude workspaces and pane/workbench
terminals:

- lifecycle and native surface phase;
- running/readiness/activity state;
- configured command and cwd;
- Claude transcript, last turn, and session metadata;
- bounded output tail only where an authoritative text stream exists.

Every result names its source, freshness, availability, and observation time.
No screenshot OCR, renderer scraping, or invented terminal text is permitted.
Unsupported output tails return an explicit `unsupported` result.

Exit when initial snapshots and subscriptions cannot miss the transition
between them, bounded reads cannot exhaust memory, and stale/offline state is
distinguishable from live state.

The implementation and deterministic verification harness satisfy those static
acceptance criteria. The first packaged scoped-pane pass mounted the real native
surface but exposed an exact-scope integration defect: pane list/get/tail/
subscribe returned `not_found`. The source repair now consumes only the exact
server-issued layout/surface scope, lists only registered granted panes, and
retains denial for mismatched or unmounted panes. Targeted terminal-observation
and Workbench harnesses cover the 255/256 discovery boundary. Rebuilt live
managed MCP confirmed the packaged defect is closed. See
[phase-05-terminal-observability.md](phase-05-terminal-observability.md).

## 6. Settings/Resources

The implementation adds three managed MCP operations through the canonical
registry:

- `settings.getEffective` for model/effort values and provenance plus read-only
  Orpheus workspace guardrails and dirty state;
- `settings.patchWorkspace` for self-only model/effort overrides through the
  existing workspace settings store and dirty recomputation;
- `resources.listProjectMetadata` for sanitized, same-project MCP server, hook,
  slash-command, and subagent metadata.

Default runtime grants remain fail-closed; tests inject exact Phase 6 grants.
Automation eligibility is narrower: only `settings.getEffective` and
`resources.listProjectMetadata` declare natural idempotency and receive fixed
Tier 0, exact-scope main grants. The workspace patch remains ineligible.
Global and project writes, permission/shell/environment settings, user/global
or cross-project resources, resource contents and mutations, and memory files
remain excluded.

Auth credentials, tokens, arbitrary secret fields, and unrestricted shell
configuration remain unavailable to MCP and automations. MCP-server, hook,
memory, slash-command, and subagent resources are introduced only with explicit
scope and ownership rules.

Deterministic verification establishes `composeClaudeLaunch` parity,
existing-store writes, restart-to-apply recomputation, exact grants,
same-project/self policy, scoped resource reads, and secret absence from
discovery, results, audit params, and errors. The packaged batch exercised
effective settings, sanitized project metadata, and a workspace effort patch,
then restored and reconfirmed the original `high` override/effective value.
The restore reported `restartRequired: false`; a native restart-required
transition therefore remains untested live. See
[phase-06-settings-resources.md](phase-06-settings-resources.md) and
[phase-06-interfaces.md](phase-06-interfaces.md).

## 7. Durable Automations

Persist automation definitions and run history. A definition names a trigger,
semantic capability, validated params, scope, enabled state, idempotency policy,
timeout, concurrency limit, and retry/budget policy.

The scheduler invokes the control core in-process with an automation principal.
It does not shell out to the CLI, simulate renderer interaction, or bypass
policy. App restart must recover definitions and reconcile interrupted runs
without duplicate effects.

Review persistence, scheduler, and execution as one bounded subsystem; external
notification/channel integrations are follow-up adapters, not prerequisites.

Exit when scheduled and event-driven runs are bounded, auditable, idempotent
where declared, recover after restart, and can be disabled safely.

The source-level implementation satisfies the deterministic Phase 7 harness.
The packaged Orpheus Dev fixture then exercised fail-closed QA authentication/
action parsing, schedule and real `workspace.completed` event runs,
duplicate-create idempotency, bounded recent-first status, request/audit
correlation, restart recovery, disable, and scoped cleanup. This does not add a
production management or grant-administration surface. See
[phase-07-durable-automations.md](phase-07-durable-automations.md).

## 8. Integrated Validation

Validate the assembled system without changing its product surface:

- catalog/schema parity across MCP, renderer, CLI, and automation;
- MCP discovery in a fresh managed workspace;
- live-operation equivalence across adapters;
- CLI offline reads with Orpheus stopped;
- identity, same-project, self-action, secret, and fan-out denial paths;
- restart/reconnect and subscription race behavior;
- automation recovery, idempotency, retry, timeout, and disable behavior;
- audit redaction and correlation;
- for each dashboard capability published after Phase 2, cache-only reads are
  side-effect-free while refresh/probe operations declare and bound
  `process.inspect`, `credential.read`, `network.request`, `process.spawn`, and
  `cache.write`;
- dashboard results preserve stale, unavailable, unsupported, and unknown
  states without exposing tokens, raw credentials, or secret-bearing process
  arguments;
- Antigravity's self-signed-certificate exception remains request-scoped to the
  hard-coded loopback language-server target and never affects cloud requests;
- absence of click/coordinate simulation from agent-visible tools.

This phase may fix integration defects, but it does not become a vehicle for new
capabilities or removal. Exit when the validation matrix records live-tested,
static-only, and untested paths separately and all release-blocking failures are
resolved. The current evidence and pending packaged checklist follow.

### Evidence rules

Phase 8 changes no product capability. It records whether a claim is supported
by source inspection, a deterministic harness, an earlier packaged/live run, or
a current packaged/live run.

- **Deterministic** means a named source-level or process-local harness covers
  the contract. It does not prove Electron startup, native surfaces, packaged
  MCP discovery, or a real renderer acknowledgement.
- **Historical live** means a recorded packaged acceptance run supports the
  claim, but later source changes may still require reconfirmation.
- **Current live** means the exact integrated source state was packaged and
  exercised through the real app surface.
- **Pending** means no success claim is made.

### Evidence ledger

| Area | Deterministic/source evidence | Packaged/live evidence | Current status |
| --- | --- | --- | --- |
| Phase 1 registry and review adapters | Dedicated control-plane harness and adapter guards pass | Exercised indirectly by later packaged runs | Deterministic pass; no new direct live proof required |
| Phase 2 identity and default MCP reads | Runtime-lease, policy, bridge, and schema harnesses pass | Historical bound-identity/denial run retained; current batch discovered exactly 11 default tools and 28 exact-scoped tools | Current discovery passed; a fresh final-build `self.get` refresh remains |
| Phase 3 workspace orchestration and CLI compatibility | Foundation, main, CLI, and renderer-action harnesses pass | Historical lifecycle/fork/archive/audit evidence retained; current packaged `open --background` mounted an unmounted Dev workspace while Home stayed visible | Background-mount and terminal-color repairs live-reconfirmed; three focused paths remain deterministic-only |
| Phase 4 Workbench/Panes | Domain, policy, renderer-broker, and exact-scope QA grant harnesses pass | Current batch exercised state, tab/file/diff/layout control and pane start/focus/stop with real acknowledgements | Core positive paths current-batch live; unavailable/partial live paths pending |
| Phase 5 terminal observation | Source/freshness, bounds, subscription, exact scoped pane, unsupported-tail, de-duplication, and denial harnesses pass after repair | Rebuilt app exposed the mounted exact-scoped pane through list/get/tail/subscribe, then omitted it and returned `not_found` after stop | Current-batch live |
| Phase 6 settings/resources | Layering, allowlist, grant, scope, redaction, and restart-to-apply harnesses pass | Current batch exercised effective settings, sanitized metadata, patch, and restore to effective `high` | Core positive paths current-batch live; native restart-required path pending |
| Phase 7 automations | Persistence, scheduler, outbox, recovery, idempotency, budget, grant, audit, and QA-fixture harnesses pass | Current batch exercised schedule/event runs, duplicate reuse, restart recovery, disable, audit correlation, and cleanup | Current-batch live |
| Phase 8 QA authentication and aggregate inventory | Strict parsing, separate credential, environment scrub, catalog, surface/idempotency, and grant-omission harnesses pass | Current batch rejected missing QA auth and malformed action, discovered default/scoped inventories, ran packaged fixtures, and rebuilt the final source | Major current-batch paths passed; residual negatives recorded below |
| CLI preservation | Compatibility harness covers live envelopes; offline readers remain independent of the app | Historical lifecycle evidence retained; current packaged background-open and app-stopped project/workspace/transcript reads passed | Existing CLI retained |
| Audit/log redaction | Dedicated redaction, exhaustive legacy purge, hostile-input, export, and operation-audit checks pass | Packaged main logs emitted structural counts/key names rather than values; automation runs carried audit correlation; Gitleaks found no staged-diff leaks | Current source and run evidence passed |

The aggregate `test:agentic-integration` script composes the Phase 4–6 QA grant,
Phase 8 QA action-authentication, durable-automation, cross-phase inventory, and
log-redaction harnesses. It does not include every earlier phase harness and
does not replace `bun run check` or the packaged checklist below.

### Current deterministic checklist

These boxes distinguish the recorded current batch from checks that must be
repeated after the final Phase 5 source repair.

- [x] Repeat `bun run check` for the exact post-repair source
- [x] Phase 1/2 control-plane and MCP bridge harnesses
- [x] `test:workspace-orchestration`, including CLI compatibility
- [x] Phase 4 Workbench/Panes control harness
- [x] Phase 5 terminal-observation and Workbench control harnesses after the
      exact scoped-pane repair
- [x] Phase 6 settings/resources harness
- [x] Repeat `test:agentic-integration` for the exact post-repair source
- [x] final diff/secret review (`git diff --check` and Gitleaks staged scan)

### Packaged/live checklist

No item below is claimed by source inspection or a deterministic harness.

- [x] Rebuild and launch the exact post-repair `Orpheus Dev.app` source state;
      native build, packaging, installation, signing verification, and
      packaged CLI/MCP executables passed.
- [x] Verify packaged MCP connection and exact default 11-tool versus exact
      scoped 28-tool discovery without mutating user/global MCP configuration.
- [ ] Refresh bound `self.get` on the final build.
- [x] Verify the configured current main-observed `live` runtime receives the
      exact Phase 4–6 project/workspace/layout/terminal grant.
- [ ] Reconfirm pending, revoked, stale, replaced, mismatched, and production
      identities remain at the default grant on the final build.
- [x] Verify a missing QA credential and malformed non-string Phase 8 action
      fail before fixture dispatch.
- [ ] Reconfirm wrong ordinary command and separate QA credentials on the final
      build.
- [x] Exercise packaged CLI `ws open --background` against an unmounted Dev
      workspace; it returned without timeout and Home remained visible.
- [ ] Exercise task start/send, focused open, and the ordinary renderer
      acknowledgement close/archive race.
- [x] Exercise Phase 4 semantic Workbench and pane state/control through a real
      renderer acknowledgement.
- [ ] Force Phase 4 unavailable/partial renderer paths live.
- [x] Exercise Phase 5 packaged native lifecycle/readiness and managed-MCP
      discovery; confirm the current libghostty output tail remains explicitly
      `unsupported`, subscription returns the mounted snapshot, and stop
      removes the pane from discovery.
- [x] Exercise Phase 6 effective settings, sanitized project metadata, and one
      workspace effort patch, then restore and reconfirm effective `high`.
- [ ] Exercise a Phase 6 mutation that produces a live restart-to-apply
      transition.
- [x] Through the fixed Phase 8 automation fixture, create/reuse schedule and
      event definitions, observe bounded recent-first status and correlated
      automation/control audit, exercise the durable workspace-completion
      event, and run explicit scoped cleanup.
- [x] Stop Orpheus and reconfirm direct CLI SQLite/JSONL reads. Existing CLI
      commands, JSON envelopes, exit codes, auto-launch, long waits, `/cmd`, and
      command-socket behavior remain compatibility contracts; Phase 8 does not
      remove or replace them.
- [x] Inspect packaged main logs for structural-only environment reporting;
      the run printed key names and byte counts, not values.
- [x] Complete the final packaged run-history/audit/secret review;
      confirm QA credentials, command tokens, runtime leases, task text, raw
      environment values, and secret-bearing process arguments are absent.
- [x] Remove the fixed Phase 8 automation definitions/runs through scoped QA
      cleanup.
- [x] Remove the disposable pane and layout through the app UI. The `General`
      panel remains because it is the built-in non-deletable panel; it now has
      zero layouts.

The final layout deletion also reproduced a pre-existing renderer selection
race outside the control-plane diff: SQLite durably deleted the fixture and
cleared the foreign-keyed selection, while a stale renderer snapshot briefly
tried to persist the deleted layout id and logged a foreign-key error. No data
was lost and the UI converged to the empty built-in panel. Follow-up should
revision-gate pane layout snapshots or invalidate them before clearing the
active selection.

### Completion rule

Phase 8 is complete only when the current deterministic checklist and required
packaged/live checklist have recorded results, failures are resolved or
explicitly accepted, and the ledger distinguishes every untested path. A
successful source harness alone must not change a pending live item to passed.

## Compatibility at the end of the roadmap

The final system intentionally retains:

- `packages/orpheus-cli/` and `resources/bin/orpheus`;
- direct read-only SQLite and Claude-file reads;
- the authenticated `cmd.sock` transport;
- typed renderer IPC;
- Quick Actions and footer consumers;
- low-level terminal steering for explicit compatibility use.

Those surfaces may become adapters over shared semantics, but their continued
existence is not technical debt to be removed by this roadmap.
