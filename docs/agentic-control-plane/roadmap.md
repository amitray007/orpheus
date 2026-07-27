# Agentic Control Plane Roadmap

**Status:** Phases 1–3 implemented and validated; Phases 4–8 planned<br>
**Companion documents:** [README.md](README.md),
[architecture.md](architecture.md),
[identity-and-permissions.md](identity-and-permissions.md),
[Phase 1](phase-01-control-foundation.md), and
[Phase 2](phase-02-self-identity-readonly-mcp.md);
[Phase 3 contract](phase-03-workspace-orchestration.md) and
[Phase 3 interfaces](phase-03-interfaces.md)

This roadmap delivers the Agentic Control Plane as eight additive, independently
reviewable phases. Each phase has a narrow contract, explicit exclusions, and a
standalone acceptance boundary. A phase may depend on the stable contracts from
an earlier phase, but it must not bundle unfinished work from the next phase.

The existing `orpheus` CLI remains supported throughout. Its commands, JSON
output, exit codes, command-socket behavior, auto-launch rules, and direct
SQLite/JSONL offline reads are compatibility contracts. The roadmap does not
replace, rewrite, or remove them.

There is no Phase F. The previously contemplated removal/deprecation phase is
gone. Completion is based on shared semantics and adapter parity, not deletion
of existing CLI, IPC, Quick Actions, or command-socket surfaces.

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
| 3. Workspace Orchestration       | Implemented and validated          | Add semantic workspace creation, task start, wait, and lifecycle control                        | One orchestration service, strict schemas, archive safety |
| 4. Self Workbench/Panes Control  | Planned                           | Let an agent control its own workbench and panes semantically                                   | Self-scoped UI commands, no click simulation              |
| 5. Terminal Observability        | Planned                           | Add authoritative terminal/session observation                                                  | Source/freshness contract and explicit unavailable states |
| 6. Settings/Resources            | Planned                           | Expose allowlisted non-secret settings and resources                                            | Layering, validation, dirty-state, and secret boundaries  |
| 7. Durable Automations           | Planned                           | Persist bounded triggers and runs that invoke semantic operations                               | Scheduler, idempotency, budgets, retries, run history     |
| 8. Integrated Validation         | Planned                           | Prove parity, recovery, policy, and compatibility across all adapters                           | Cross-surface contract and live validation matrix         |

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
behavior; renderer create/fork; and cleanup. That packaged/live evidence
predates the final source-only renderer-readiness queue/ack, explicit-name,
CLI `--no-submit`, and ambient `NO_COLOR` fixes. Those fixes have static
regressions only and must be reconfirmed together in the next batched
integration pass; no post-fix packaged build is claimed.

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

## 5. Terminal Observability

Expose authoritative observation for Claude workspaces and pane/workbench
terminals:

- lifecycle and native surface phase;
- running/readiness/activity state;
- configured command and cwd;
- Claude transcript, last turn, and session metadata;
- bounded output tail only where an authoritative text stream exists.

Every result names its source and observation time. No screenshot OCR, renderer
scraping, or invented terminal text is permitted. Unsupported output tails
return an explicit unavailable result.

Exit when initial snapshots and subscriptions cannot miss the transition
between them, bounded reads cannot exhaust memory, and stale/offline state is
distinguishable from live state.

## 6. Settings/Resources

Add scoped, allowlisted reads and safe writes for non-secret Orpheus/Claude
settings and resources. Preserve global → project → workspace composition,
effective-value inspection, validation, and restart-to-apply dirty semantics.

Auth credentials, tokens, arbitrary secret fields, and unrestricted shell
configuration remain unavailable to MCP and automations. MCP-server, hook,
memory, slash-command, and subagent resources are introduced only with explicit
scope and ownership rules.

Exit when effective reads match `composeClaudeLaunch`, writes use existing
domain stores rather than raw SQL, and secret fields are absent from discovery,
results, audit params, and errors.

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
resolved.

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
