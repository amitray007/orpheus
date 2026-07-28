# Phase 7: Durable Automations

**Status:** implemented and deterministically verified; packaged schedule,
event, restart-recovery, and cleanup paths historically live-validated.
Production renderer/MCP management APIs, the Settings renderer surface, and
manual retry generations are source-complete. A Settings no-op round-trip save
was packaged-live validated on 2026-07-28; material field edits and remaining
management paths are pending<br>
**Roadmap:** [roadmap.md](roadmap.md)<br>
**Validation ledger:** [Phase 8](roadmap.md#8-integrated-validation)<br>
**Depends on:** the canonical control registry and declarative database migration engine

## Outcome

Phase 7 persists bounded automation definitions and immutable logical run
identities. A main-process scheduler turns a supported schedule or internal
domain event into a run and invokes an automation-eligible control descriptor
in-process with a server-resolved `automation` principal.

The subsystem is operation-agnostic. Phase 4–6 operations become eligible only
by declaring the `automation` surface, an idempotency contract, and their
ordinary permission, scope, risk, schema, and effects in the canonical
descriptor. Phase 7 does not import those domain implementations.

The scheduler never:

- shells out to the Orpheus CLI;
- injects renderer clicks, coordinates, selectors, or keys;
- calls an operation omitted from the canonical `automation` surface;
- trusts a definition to grant its own permission, scope, or risk tier;
- adds email, chat, webhook, notification, or external channel adapters.

## Persisted model

`automation_definitions` stores:

- immutable definition id and operation version;
- name, operation id, strict operation params, and bounded scope;
- one interval schedule or one allowlisted internal event trigger;
- enabled state and the next scheduled due time;
- idempotency mode;
- per-attempt timeout and concurrency limit;
- retry count and exponential-backoff bounds;
- aggregate per-run elapsed-time budget;
- rolling start-count budget and window;
- creation/update timestamps.

It does not store a permission grant, caller-supplied principal, runtime lease,
shell command, renderer gesture, or secret-bearing environment.

`automation_runs` stores one row per logical trigger occurrence:

- run, definition, trigger, and stable idempotency keys;
- current attempt and state;
- queued/start/finish/retry timestamps;
- stable control error/result code;
- recursively redacted result/error metadata;
- request and control-audit correlation ids.

A unique `(automation_id, idempotency_key)` index prevents two run rows for one
logical occurrence. Attempts update that row; they do not create a second
logical run.

`automation_event_occurrences` is the durable internal-event outbox. It stores
the bounded event identity/type/time/scope, delivery attempts and retry time,
and the delivered timestamp. Pending occurrences are never removed by
retention. Delivered occurrences are retained for at most 30 days and 10,000
rows.

## Trigger contract

Phase 7 supports exactly two trigger shapes:

```ts
type AutomationTrigger =
  | {
      kind: 'schedule'
      intervalMs: number // 1 second through 30 days
      startAt?: number // epoch milliseconds
    }
  | {
      kind: 'event'
      eventType: string // server allowlisted, 1..128 characters
    }
```

Schedules are fixed intervals, not cron expressions. At most one overdue
occurrence is enqueued per scheduler reconciliation. The next due time advances
past `now`, preventing an unbounded restart catch-up storm.

Events arrive through an in-process persistence seam with a server-issued event
id, event type, time, and optional project/workspace attribution. The scheduler
does not synthesize identity from event payloads. Definition scope must contain
the event attribution, and the server allowlist must include the event type.
One event fans out to at most 200 matching definitions per reconciliation.

Main currently allowlists one production event: `workspace.completed`. It is
inserted in the same SQLite transaction as the authoritative workspace status
write when the persisted old status is `in_progress` or `attention` and the new
status is `awaiting_input`. The event carries the persisted workspace/project
attribution and a bounded unique occurrence id. The post-commit observer only
prompts an outbox drain; it is not the durable source.

## Scope and grants

A definition has one scope:

```ts
type AutomationScope =
  | { kind: 'app' }
  | { kind: 'project'; projectId: string }
  | { kind: 'workspace'; projectId: string; workspaceId: string }
```

Definitions cannot contain grants. A server-owned grant source resolves from
the automation id, already validated params, requested scope, and canonical
descriptor. Main's fixed default policy grants five naturally idempotent
operations for an exact existing workspace: `settings.getEffective`,
`settings.patchWorkspace`, `workspaces.getLineage`, `workspaces.reopen`, and
`workspaces.rename`. The grant source requires an exact match on operation kind,
permission, risk tier, declared effects, scope, surface, and idempotency.
Project resource discovery, app/project scopes, and all other operations fail
closed.
Creation/update, enable, scheduler reconciliation, and immediately-before-
invoke checks all re-resolve the grant. Absence of a grant fails closed.

The invocation context contains the automation principal, definition scope,
run id, idempotency key, deadline, and abort signal. Ambient workspace
environment and command-socket tokens are never authority.

## Idempotency and restart recovery

Automation-eligible descriptors declare one of:

- `none`: an interrupted attempt is terminal and is never replayed;
- `natural`: replay is safe because repeating the operation converges;
- `keyed`: the handler honors the stable invocation idempotency key and
  deduplicates committed effects.

A definition cannot claim a stronger mode than its descriptor. `keyed`
definitions receive the same key for every attempt and after restart.

On restart:

1. pending event occurrences atomically materialize idempotent run rows and are
   marked delivered before any handler starts; a crash on either side replays
   safely;
2. persisted `running` rows become `interrupted`;
3. `none` rows remain terminal, avoiding a blind replay of possibly committed
   effects;
4. `natural` and `keyed` rows move to bounded retry only when retry and
   aggregate run budgets still allow it;
5. persisted `queued` and `retry_wait` rows resume;
6. terminal rows are never enqueued again.

An outbox delivery failure rolls back any partially materialized runs, leaves
the occurrence pending, and records deterministic exponential backoff capped
at one hour. An occurrence with no matching enabled definition is still
delivered. Reusing an event id with different contents is rejected.

This is at-least-once execution only for operations that explicitly tolerate
it, and at-most-once replay behavior for `none`. Phase 7 does not claim
transactional exactly-once effects across arbitrary domain stores.

## Bounds

Definitions use hard limits:

- timeout: 100 ms through 5 minutes per attempt;
- concurrency: 1 through 8 active runs per definition;
- attempts: 1 through 8 per logical run;
- retry base delay: 100 ms through 1 minute;
- retry maximum delay: base delay through 1 hour;
- aggregate run elapsed budget: timeout through 24 hours;
- rolling window: 1 second through 24 hours;
- rolling starts: 1 through 10,000.

Backoff is deterministic exponential delay capped by the configured maximum.
Timeout uses an abort signal. An automation-eligible handler must cooperate
with that signal; the executor ignores any late transport result after the
deadline and never schedules two attempts for the same run concurrently.

Disable prevents new schedule/event runs and cancels queued/retry-wait runs.
An already-running operation receives cancellation and records its eventual
bounded outcome; disable does not pretend to roll back effects.
The enabled state, next scheduled time, and pending-run cancellation commit in
one SQLite transaction.

Terminal run history is retained for at most 30 days and 1,000 rows per
definition. Delivered event occurrences are retained for at most 30 days and
10,000 rows; undelivered occurrences are not pruned. Malformed persisted
definition JSON fails closed and is never scheduled or invoked.

## Audit and redaction

Every attempt uses a request id correlated with definition id, run id,
idempotency key, and attempt number. Workspace orchestration receives the same
correlation in its existing control audit. The run row stores the resulting
audit id when the canonical result exposes one.

Run results, errors, and scheduler diagnostics are recursively redacted with
the control-plane redactor. Task/text fields become hash, byte length, and a
safe summary. Secret-like keys never enter run history. Raw params remain only
in the definition row required to execute the validated semantic operation;
management audit records use redacted params.

Definition creation, enable/disable, and deletion persist a completed audit in
the same SQLite transaction as the state change. Validation, grant, conflict,
and persistence failures emit a denied/failed audit with request, definition,
and principal correlation; an audit-write failure rolls the mutation back.

There is still no production grant-administration surface. Current source adds
a strict renderer IPC/preload automation-management API for:

- operation catalog and definition list/detail;
- create/update with validated drafts and optimistic `updatedAt` checks;
- enable/disable and delete;
- bounded run history with eligibility metadata;
- manual retry as a new retry generation linked to the source run.

Creation/update persists a definition disabled until an explicit enable action.
Settings → Automations is source-complete. It provides the server-owned safe
operation catalog, a definition list/editor, explicit confirmations before
enable, delete, or retry, and bounded redacted run history. The run view
refreshes from push events and a visibility-aware four-second poll. On
2026-07-28, a packaged manual renderer pass selected an existing MCP-created
project-descriptor/workspace definition and performed a no-op Save. It continued
to display `Workspace` scope and its revision advanced. Material field edits,
enable/delete/retry confirmations, and run-history behavior remain untested
through the packaged renderer.

Nine matching managed-MCP descriptors are also source-complete:

- Tier 0: `automations.catalog`, `automations.list`, `automations.get`, and
  `automations.listRuns`;
- Tier 2: `automations.create`, `automations.update`,
  `automations.setEnabled`, `automations.delete`, and
  `automations.retryRun`.

All require `automations.manage`, a valid live workspace-agent binding, and the
calling runtime's exact bound project/workspace. Create/update reject any other
scope; list/get/run/retry paths filter ownership and return non-enumerating
`not_found` outside it. Create/update force the definition disabled until an
explicit enable operation. Mutations use the management audit path, and update,
enable, and delete require the current `updatedAt` revision.

These descriptors allow only the `mcp` surface and declare no automation
eligibility. An automation therefore cannot manage or retry automations.
Settings Agent Tools may further suppress their `automations` category without
widening authority. This MCP surface is source/deterministic evidence only until
a fresh packaged managed-runtime pass exercises it.

The current agentic harness snapshot reports 48 registered, 48 MCP, 48
default-exposed, 48 runtime-visible, and 5 automation-eligible operations. That
count is dated verification evidence rather than a stable catalog contract;
the eligible set is the fixed five-operation exact-workspace allowlist
documented above.

The authenticated command-socket fixture used by the historical packaged batch
has been removed from the runtime now that production Settings and MCP
management paths exist. Its environment capture, injected grants, extra command
dispatch, and fixture controller are not included in the application bundle.
The historical results below remain evidence for that build only; current
regression coverage invokes the production service, scheduler, event bridge,
renderer-management, and MCP-management interfaces directly.

## Acceptance boundary

Deterministic verification covers:

- declarative creation and idempotent reconciliation of definitions, runs, and
  event-outbox tables/indexes;
- strict definition, trigger, scope, and target-operation validation;
- absent/insufficient/stale server grant denial;
- schedule catch-up bounds and event scope filtering;
- same-key deduplication and concurrency races;
- timeout, retry, deterministic backoff, per-run and rolling budgets;
- enable/disable behavior;
- restart reconciliation for `none`, `natural`, and `keyed`;
- source-transaction rollback, delivery failure/backoff, startup replay, and
  outbox/run deduplication;
- no replay of terminal success;
- automation principal/context propagation;
- audit/run correlation and recursive result redaction;
- production automation discovery, natural replay behavior, exact-workspace
  grants, and exclusion of resource discovery and non-allowlisted mutations;
- the five production settings/workspace descriptors through durable
  definition creation, fixed server grant resolution, scheduler invocation,
  persisted run/history/audit correlation, same-occurrence deduplication,
  convergent replay, exact-scope denial, and state cleanup;
- production management create/update/enable/delete/list/retry policy, revision,
  audit, and ownership behavior;
- transactional workspace-event persistence, post-commit delivery, and
  run/audit correlation without a packaged-only fixture;
- absence of CLI subprocess and renderer-gesture dependencies.

The historical packaged Orpheus Dev integration batch exercised the fixed QA
fixture before the production management API was added:

- a missing QA credential and malformed non-string action failed before fixture
  dispatch;
- duplicate schedule creation reused the same definition id;
- the schedule produced bounded recent-first successful runs and rolling-budget
  retry-wait outcomes;
- a real `workspace.completed` transition produced one successful event run;
- run rows carried request and control-audit correlation ids;
- after app restart, the enabled schedule recovered, produced new successful
  runs, and reconciled older retry-wait rows;
- schedule/event definitions were disabled and scoped fixture cleanup
  completed.

These remain historical packaged fixture results, not current-live evidence for
the production MCP management API or manual retry generations. The fixture code
has since been removed. The separate 2026-07-28 Settings save proves only the
no-op round trip, retained workspace-scope, and revision-advance path described
above.
