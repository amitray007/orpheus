# Phase 7: Durable Automations

**Status:** contract frozen; statically implemented and verified
**Roadmap:** [roadmap.md](roadmap.md)
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

Events arrive through an in-process `emitEvent` seam with a server-issued event
id, event type, time, and optional project/workspace attribution. The scheduler
does not synthesize identity from event payloads. Definition scope must contain
the event attribution, and the server allowlist must include the event type.
One event fans out to at most 200 matching definitions per reconciliation.

## Scope and grants

A definition has one scope:

```ts
type AutomationScope =
  | { kind: 'app' }
  | { kind: 'project'; projectId: string }
  | { kind: 'workspace'; projectId: string; workspaceId: string }
```

Definitions cannot contain grants. A server-owned grant source resolves, by
automation id, allowed permissions, maximum risk tier, and allowed scopes.
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

1. persisted `running` rows become `interrupted`;
2. `none` rows remain terminal, avoiding a blind replay of possibly committed
   effects;
3. `natural` and `keyed` rows move to bounded retry only when retry and
   aggregate run budgets still allow it;
4. persisted `queued` and `retry_wait` rows resume;
5. terminal rows are never enqueued again.

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
definition. Malformed persisted definition JSON fails closed and is never
scheduled or invoked.

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

Definition creation and enable/disable state changes persist a completed audit
in the same SQLite transaction as the state change. Validation, grant, conflict,
and persistence failures emit a denied/failed audit with request, definition,
and principal correlation; an audit-write failure rolls the mutation back.

## Acceptance boundary

Deterministic verification covers:

- declarative creation and idempotent reconciliation of both tables/indexes;
- strict definition, trigger, scope, and target-operation validation;
- absent/insufficient/stale server grant denial;
- schedule catch-up bounds and event scope filtering;
- same-key deduplication and concurrency races;
- timeout, retry, deterministic backoff, per-run and rolling budgets;
- enable/disable behavior;
- restart reconciliation for `none`, `natural`, and `keyed`;
- no replay of terminal success;
- automation principal/context propagation;
- audit/run correlation and recursive result redaction;
- absence of CLI subprocess and renderer-gesture dependencies.

Static harnesses do not claim live app, renderer, packaged build, or real
Phase 4–6 operation validation. Those paths are batched into Phase 8.
