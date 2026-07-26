# Agentic Control Plane Roadmap

**Status:** implementation sequence<br>
**Companion documents:** [README.md](README.md),
[architecture.md](architecture.md),
[identity-and-permissions.md](identity-and-permissions.md)

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
- can be rolled back without migrating user data backward.

## Phase summary

| Phase | Outcome | Primary review boundary |
| --- | --- | --- |
| 1. Control Foundation | Add a transport-neutral capability registry and prove it with the two review-comment operations | Registry contract plus preserved IPC/socket adapters |
| 2. Self Identity + Read-only MCP | Ship managed MCP discovery with identity and read-only tools | MCP bootstrap, contextual tool filtering, read schemas |
| 3. Workspace Orchestration | Add semantic workspace creation, task start, wait, and lifecycle control | Existing guardrails expressed once in the control core |
| 4. Self Workbench/Panes Control | Let an agent control its own workbench and panes semantically | Self-scoped UI commands, no click simulation |
| 5. Terminal Observability | Add authoritative terminal/session observation | Source/freshness contract and explicit unavailable states |
| 6. Settings/Resources | Expose allowlisted non-secret settings and resources | Layering, validation, dirty-state, and secret boundaries |
| 7. Durable Automations | Persist bounded triggers and runs that invoke semantic operations | Scheduler, idempotency, budgets, retries, run history |
| 8. Integrated Validation | Prove parity, recovery, policy, and compatibility across all adapters | Cross-surface contract and live validation matrix |

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

Bundle an Orpheus MCP stdio adapter into managed Claude launches. The preferred
direction is a managed launch-time `--mcp-config` that does not mutate
user/global `.mcp.json`; the exact Claude launch integration remains subject to
implementation verification. Generate `tools/list` from the canonical catalog,
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

Exit when a fresh managed workspace discovers the read tools without prompt
instructions or manual configuration, schemas match the catalog, reads identify
their source/freshness, and a caller cannot discover another project's
restricted data.

## 3. Workspace Orchestration

Publish semantic mutations for workspace creation, task start, wait, send,
open/background activation, close, reopen, rename, and archive. Preserve the
existing CLI behavior while routing shared semantics through the control core.

The core owns:

- same-project defaults and explicit cross-project checks;
- parent lineage and fork resolution;
- max-depth/max-children limits;
- self-close/self-archive protection;
- readiness and bounded task injection;
- stable wait outcomes and timeout behavior;
- mutation audit context.

Review this phase as workspace-domain work only. Do not include workbench,
panes, settings, or automation.

Exit when MCP and live CLI operations produce equivalent domain outcomes and
policy failures, while CLI offline reads and existing exit codes remain
unchanged.

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
