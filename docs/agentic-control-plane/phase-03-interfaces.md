# Phase 3: Workspace Orchestration Interfaces

**Status:** contract frozen; implementation in progress; not yet implemented<br>
**Phase contract:** [phase-03-workspace-orchestration.md](phase-03-workspace-orchestration.md)

## Purpose

This document freezes the transport-neutral Phase 3 operation interfaces. The
JSON Schema registered in the canonical control catalog is authoritative when
implementation lands. MCP generates `tools/list` from those descriptors; it
does not maintain a second schema.

The outlines below are intentionally strict:

- every input is an object with `additionalProperties: false`;
- identifiers and text are non-empty strings with explicit size bounds;
- counts and timeouts are finite integers with explicit bounds;
- tagged alternatives reject contradictory fields;
- omitted targets resolve from trusted runtime identity, never ambient MCP
  context;
- outputs contain no token, runtime lease, secret environment value, raw
  terminal byte sequence, or caller-supplied cwd.

## Common types

The implementation should publish self-contained JSON Schemas equivalent to
these transport-neutral types:

```ts
type WorkspaceId = string // 1..128 characters
type ProjectId = string // 1..128 characters
type DisplayName = string // trimmed, 1..120 characters
type TaskText = string // 1..65_536 UTF-8 bytes

type Presentation = 'background' | 'focus'

type WorkspaceRef = {
  workspaceId: WorkspaceId
  projectId: ProjectId
  name: string
  mode: 'local' | 'worktree'
  cwd: string
  parentWorkspaceId: WorkspaceId | null
  closedAt: number | null
  archivedAt: number | null
}

type EffectReceipt = {
  effect: string
  status: 'applied' | 'skipped' | 'failed'
  workspaceId?: WorkspaceId
  resourceId?: string
  message?: string
}

type WorkspaceOperationReceipt<T> = {
  schemaVersion: 1
  requestId: string
  operationId: string
  status: 'completed' | 'partial'
  target: {
    projectId: ProjectId
    workspaceId: WorkspaceId | null
  }
  value: T
  effects: EffectReceipt[]
  auditId: string
}
```

`cwd` is an output observation derived by main. It is never accepted in an MCP
input.

## Catalog

| Operation | Kind | Permission | Tier | MCP |
| --- | --- | --- | ---: | --- |
| `workspaces.getLineage` | query | `workspaces.read` | 0 | yes |
| `workspaces.create` | mutation | `workspaces.create` | 2 | yes |
| `workspaces.startTask` | mutation | `workspaces.send` | 2 | yes |
| `workspaces.open` | mutation | `workspaces.open` | 1 | yes |
| `workspaces.send` | mutation | `workspaces.send` | 2 | yes |
| `workspaces.wait` | query | `workspaces.wait` | 0 | yes |
| `workspaces.close` | mutation | `workspaces.close` | 2 | yes |
| `workspaces.reopen` | mutation | `workspaces.open` | 1 | yes |
| `workspaces.rename` | mutation | `workspaces.rename` | 2 | yes |
| `workspaces.archive` | mutation | `workspaces.archive` | 3 | yes |

All descriptors are version `1`. Phase 3 does not publish a generic
`workspaces.invoke`, settings bag, terminal key operation, or force lifecycle
operation.

## `workspaces.getLineage`

Input:

```ts
type GetLineageInput = {
  workspaceId?: WorkspaceId
}
```

Output:

```ts
type GetLineageOutput = {
  workspace: WorkspaceRef
  ancestors: WorkspaceRef[] // parent first, then rootward
  children: WorkspaceRef[] // direct children only
}
```

The omitted target defaults to the trusted bound workspace. Ancestors and
children are filtered by the same bound project; an inconsistent persisted
relationship returns `conflict` rather than leaking another project.

## `workspaces.create`

Input:

```ts
type CreateWorkspaceInput = {
  mode: 'local' | 'worktree'
  name?: DisplayName
  parentWorkspaceId?: WorkspaceId
  fork?: boolean // default false
  branch?: string // worktree only; trimmed, 1..255 characters
  presentation?: Presentation // default background
}
```

Strict cross-field rules:

- `branch` is rejected for `mode: "local"`;
- cwd, path, project id, task, settings, environment, model, permission mode,
  effort, shell initialization, provider, and unknown fields are rejected;
- an omitted parent defaults from the trusted binding;
- `fork: true` requires an eligible resolved parent but does not require a task;
- mode and parent cannot select or infer another project.

Output:

```ts
type CreateWorkspaceOutput = WorkspaceOperationReceipt<{
  workspace: WorkspaceRef
  lineage: {
    parentWorkspaceId: WorkspaceId | null
    forkedFromConversationId: string | null
  }
  presentation: Presentation
}>
```

The output cwd is server-derived. A worktree branch receipt identifies the
resolved branch without returning internal shell commands.

## `workspaces.startTask`

Input:

```ts
type StartTaskInput = {
  workspaceId?: WorkspaceId
  text: TaskText
  presentation?: Presentation // default background
}
```

Output:

```ts
type StartTaskOutput = WorkspaceOperationReceipt<{
  workspaceId: WorkspaceId
  accepted: true
  submitted: true
}>
```

This operation always submits. It does not accept settings, a cwd, key names,
raw bytes, or a timeout override. The adapter supplies its bounded readiness
deadline.

## `workspaces.open`

Input:

```ts
type OpenWorkspaceInput = {
  workspaceId?: WorkspaceId
  presentation?: Presentation // default background
}
```

Output:

```ts
type OpenWorkspaceOutput = WorkspaceOperationReceipt<{
  workspace: WorkspaceRef
  presentation: Presentation
  runtimeState: 'retained' | 'started'
}>
```

A closed workspace returns `conflict`; callers use `workspaces.reopen` first.
Background presentation must not emit an `ui.focus` receipt.

## `workspaces.send`

Input:

```ts
type SendWorkspaceInput = {
  workspaceId?: WorkspaceId
  text: TaskText
  submit?: boolean // default true
  presentation?: Presentation // default background
}
```

Output:

```ts
type SendWorkspaceOutput = WorkspaceOperationReceipt<{
  workspaceId: WorkspaceId
  accepted: true
  submitted: boolean
}>
```

The MCP schema has no `keys`, `key`, `keyCode`, `sequence`, `bytes`, `cwd`,
settings, or arbitrary passthrough field. A legacy adapter may retain an
existing low-level command outside this descriptor.

## `workspaces.wait`

Input:

```ts
type WaitWorkspacesInput = {
  workspaceIds?: WorkspaceId[] // 1..32 unique ids; omitted means bound workspace
  until?: 'done' | 'input' | 'idle' // default done
  timeoutMs?: number // MCP: integer 1..25_000; default 25_000
}
```

Output:

```ts
type WaitWorkspaceResult = {
  workspaceId: WorkspaceId
  outcome:
    | 'done'
    | 'blocked_permission'
    | 'blocked_input'
    | 'died'
    | 'timeout'
    | 'not_found'
  status: string | null
  observedAt: number
}

type WaitWorkspacesOutput = {
  schemaVersion: 1
  requestedUntil: 'done' | 'input' | 'idle'
  timedOut: boolean
  results: WaitWorkspaceResult[]
}
```

The MCP descriptor caps `timeoutMs` at 25 seconds. The shared service receives a
validated deadline from its adapter; the CLI adapter may retain its existing
long-duration range. A per-target `timeout` is an ordinary output. Authorization
or invalid input still uses the control error envelope.

`workspaceIds` are deduplicated only after schema validation; duplicates are
`invalid` so caller mistakes remain visible. A target that existed during
authorization but disappears during the wait returns per-target `not_found`.
An initially unknown or cross-project target fails the invocation with
non-enumerating `not_found`.

## `workspaces.close`

Input:

```ts
type CloseWorkspaceInput = {
  workspaceId: WorkspaceId
}
```

Output:

```ts
type CloseWorkspaceOutput = WorkspaceOperationReceipt<{
  workspace: WorkspaceRef
  closed: true
}>
```

The target is required so a destructive lifecycle request cannot silently
default to self. There is no force field. Self close is `forbidden`.

## `workspaces.reopen`

Input:

```ts
type ReopenWorkspaceInput = {
  workspaceId: WorkspaceId
}
```

Output:

```ts
type ReopenWorkspaceOutput = WorkspaceOperationReceipt<{
  workspace: WorkspaceRef
  closed: false
}>
```

Reopen changes persisted lifecycle state only. It does not mount, start, or
focus the workspace.

## `workspaces.rename`

Input:

```ts
type RenameWorkspaceInput = {
  workspaceId?: WorkspaceId
  name: DisplayName
}
```

Output:

```ts
type RenameWorkspaceOutput = WorkspaceOperationReceipt<{
  workspace: WorkspaceRef
  previousName: string
}>
```

Names are trimmed and normalized before equality comparison. A no-op rename
returns a completed receipt with `db.write` skipped.

## `workspaces.archive`

Input:

```ts
type ArchiveWorkspaceInput = {
  workspaceId: WorkspaceId
  recursive?: boolean // default false
}
```

There is no `force`, dirty-worktree override, branch-deletion option,
reparenting option, or path field.

Output:

```ts
type ArchiveWorkspaceOutput = WorkspaceOperationReceipt<{
  rootWorkspaceId: WorkspaceId
  recursive: boolean
  order: WorkspaceId[] // children first, root last
  workspaces: Array<{
    workspaceId: WorkspaceId
    status: 'archived' | 'skipped' | 'failed'
    persistedRecord: 'removed' | 'retained'
  }>
}>
```

Nonrecursive archive returns `conflict` when children exist and applies no
effects. Recursive archive preflights the whole subtree, including authorization,
self-protection, lineage stability, runtime teardown, and dirty worktrees,
before deletion begins. A preflight failure returns no success receipt.

Once effects begin, an unexpected failure returns a receipt with
`status: "partial"`, an explicit workspaces array, and applied/skipped/failed
effect receipts. The service never marks an unremoved record as archived.

## Invocation and error envelope

Phase 3 continues the Phase 1–2 control envelope:

```ts
type ControlResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      error: {
        code:
          | 'invalid'
          | 'not_found'
          | 'forbidden'
          | 'conflict'
          | 'busy'
          | 'unavailable'
          | 'timeout'
          | 'failed'
        message: string
        details?: Record<string, unknown>
      }
    }
```

Error details, when present, are schema-defined and recursively redacted. They
must not contain tokens, raw text, environment values, internal exceptions, or
cross-project identity. A partial operation is `ok: true` with a typed partial
receipt; adapters must not collapse it into an unqualified success message.

## Adapter contracts

### MCP

- Uses only a valid runtime-scoped lease.
- Publishes the strict catalog schemas above.
- Defaults targets only from main-resolved trusted identity.
- Caps wait and readiness work at 25 seconds per invocation.
- Never publishes settings overlays, arbitrary keys, force archive, or a
  generic passthrough object.

### CLI and command socket

- Retains current command names, JSON envelopes, human output, exit codes,
  background/focus defaults, offline reads, and long wait durations.
- May translate legacy create flags into a validated internal compatibility
  input, but the public MCP schema remains unchanged.
- Treats `--fork` as a complete creation intent without `--task` or `--empty`;
  `--task` and `--empty` remain mutually exclusive.
- Preserves auto-launch and a single retry.
- On a stale authentication/socket failure, clears the cached token and socket,
  resolves or launches the app again, and performs the one retry with fresh
  material.
- Maps stable control errors and partial receipts to existing exit/output
  behavior without changing the service result.

### Renderer

- Invokes semantic operations through typed IPC.
- Keeps selection, animation, and other renderer-only presentation state out of
  service inputs.
- Does not recreate archive, lineage, or self-action policy.

## Audit interface

The dedicated control audit receives one structural record per decision:

```ts
type WorkspaceControlAuditRecord = {
  schemaVersion: 1
  auditId: string
  requestId: string
  occurredAt: number
  consumer: 'mcp' | 'renderer' | 'cli' | 'automation'
  operation: { id: string; version: 1 }
  principal: {
    kind: string
    runtimeId: string | null
  }
  target: {
    projectId: string | null
    workspaceIds: string[]
  }
  permission: string
  tier: 0 | 1 | 2 | 3
  decision: 'allow' | 'ask' | 'deny'
  declaredEffects: string[]
  redactedParams: Record<string, unknown>
  receipts: EffectReceipt[]
  result: {
    code: 'completed' | 'partial' | 'invalid' | 'not_found' | 'forbidden'
      | 'conflict' | 'busy' | 'unavailable' | 'timeout' | 'failed'
  }
}
```

Redaction is recursive and occurs before persistence and diagnostics. Text
fields use hash, byte length, and safe summary. The Quick Actions audit table is
not this interface and must not be reused as the Phase 3 control audit.

## Verification contract

The Phase 3 deterministic harness must assert:

1. descriptor/schema parity and rejection of every unknown field;
2. permission, tier, scope, and maximum-effect metadata;
3. trusted defaults, same-project filtering, and self-action denial;
4. server-derived cwd and managed worktree paths;
5. fork lineage and fork-alone CLI parsing;
6. create/start composition and typed effect receipts;
7. background default and explicit focus receipts;
8. MCP wait maximum and retained CLI duration range;
9. lifecycle state conflicts and idempotent/no-op receipts;
10. recursive archive preflight, zero-effect denials, children-first order, and
    injected partial failures;
11. dedicated audit persistence and recursive redaction;
12. token-cache invalidation across auto-launch/retry;
13. retained CLI envelopes, human output, exit codes, and offline reads.

Packaged live validation uses the matrix in
[phase-03-workspace-orchestration.md](phase-03-workspace-orchestration.md).
Until both implementation and its stated validation exist, the status remains
“contract frozen; implementation in progress,” not implemented.
