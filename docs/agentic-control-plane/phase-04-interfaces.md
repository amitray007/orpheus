# Phase 4: Workbench and Pane Interfaces

**Status:** implemented, deterministically tested, and packaged-live validated.
Workspace-owned terminal creation, output observation, Retina-correct rendering,
and exact dual-CAS deletion passed against the packaged Dev app.<br>
**Phase contract:** [phase-04-workbench-pane-control.md](phase-04-workbench-pane-control.md)

All descriptors are version 1, use `additionalProperties: false`, and are
published only to renderer IPC and managed MCP.

```ts
type Id = string // 1..128 characters
type RelativePath = string // normalized POSIX, 1..4096 UTF-8 bytes

type WorkbenchGetStateInput = {}
type WorkbenchSelectTabInput = { tab: 'git' | 'terminal' | 'files' }
type WorkbenchOpenFileInput = {
  path: RelativePath
  mode?: 'viewer' | 'preview'
}
type WorkbenchOpenDiffInput = {
  target: { kind: 'working-tree-file'; path: RelativePath } | { kind: 'local-review'; reviewId: Id }
}

type PaneTargetInput = { layoutId: Id }
type PaneTerminalTargetInput = { layoutId: Id; terminalId: Id }
type PaneCreateWorkspaceTerminalInput = {
  layoutName?: string // trimmed, 1..128 characters
  terminalName?: string // trimmed, 1..128 characters
  initialCommand?: string // one-shot, <=8192 UTF-8 bytes, NUL-free
}
type PaneDeleteTerminalLayoutInput = {
  layoutId: Id
  terminalId: Id
  expectedLayoutUpdatedAt: number // non-negative safe integer
  expectedTerminalUpdatedAt: number // non-negative safe integer
}
```

No Workbench input includes `workspaceId`; main derives it from the runtime
lease. Relative paths reject absolute paths, empty segments, `.`, `..`, NUL,
backslashes, and paths outside the bound workspace after canonical resolution.
`panes.createWorkspaceTerminal` likewise accepts no caller-supplied
`workspaceId`, `projectId`, cwd, panel, split tree, position, or `autoStart`.
Main resolves the trusted self workspace and uses its exact persisted
`WorkspaceRecord.cwd`.

The optional `initialCommand` is the one deliberate command input. Its UTF-8
encoding is limited to 8192 bytes and rejects NUL. Main never persists it: the
created terminal row stores an empty `command`, while a dedicated provisioning
start port carries the value ephemerally to the first native mount attempt.
It is attempted at most once and cannot replay after failure or restart.
Neither operation returns it, and it must not appear in logs. Control audit data
records only its SHA-256 and byte length. This does not change ordinary
user-created pane commands, which remain intentionally persistent.

```ts
type WorkbenchStateV1 = {
  schemaVersion: 1
  workspaceId: Id
  observedAt: number
  source: 'renderer-live'
  workbench: {
    state: 'dormant' | 'open' | 'expanded'
    activeTab: 'git' | 'terminal' | 'files'
  }
  file: { path: string; mode: 'viewer' | 'preview' } | null
  diff: {
    kind: 'working-tree-file' | 'local-review'
    path: string
    reviewId: string | null
  } | null
}

type PaneStateV1 = {
  schemaVersion: 1
  observedAt: number
  source: 'renderer-live'
  layoutId: Id
  panelId: Id
  selected: boolean
  focusedTerminalId: Id | null
  terminals: Array<{
    terminalId: Id
    selected: boolean
    desiredState: 'running' | 'stopped'
  }>
}

type PaneTerminalLayoutMutationV1 = {
  layoutId: Id
  panelId: Id
  terminalId: Id
  layoutUpdatedAt: number
  terminalUpdatedAt: number
  observationTarget: {
    kind: 'pane'
    layoutId: Id
    paneId: Id // exactly terminalId
  }
}
```

`desiredState` is renderer intent, not authoritative native liveness. Mutations
return the Phase 3 receipt envelope with actual effect receipts and audit id.
Unknown and unauthorized pane resources both return non-enumerating
`not_found`.

## Workspace terminal lifecycle contract

`panes.createWorkspaceTerminal` requires a trusted self runtime lease and
`panes.manage`. It creates one layout, one terminal, and a root single-leaf
split tree atomically in the built-in `General` panel, persisting the exact
trusted workspace ID as `agent_owner_workspace_id`. Main chooses the next
layout position, forces `autoStart` off, enforces at most four agent-owned
layouts for the workspace, and enforces the panel-wide 12-terminal cap. The
returned value is only
`PaneTerminalLayoutMutationV1`; it never includes cwd or command text.
`observationTarget` can be passed directly to `terminals.getOutputTail`; its
`paneId` is exactly `terminalId`, never `panelId`.

The durable records, including an empty persistent terminal command, are the
first applied effect. The one-shot initial command exists only in memory for the
dedicated first-start call. Starting the configured surface/process, presenting
the new layout through the renderer, and focusing the native terminal are
subsequent stages. Native mount acceptance and semantic renderer presentation
are recorded separately; `ui.present` is not native visibility proof. A missing
or invalid renderer acknowledgement returns `partial`. Native focus has no
authoritative acknowledgement, so `ui.focus` is reported `skipped`/unconfirmed,
not `applied`, and its absence alone does not manufacture a partial failure.
`shell.execute` remains a maximum declared effect, but the receipt does not
claim it `applied` without an authoritative execution acknowledgement. Failure
after creation returns `partial` with the exact created IDs, both CAS
timestamps, and only the effects known to have occurred; it does not pretend
that the durable records were rolled back or replay the ephemeral command.

`panes.deleteTerminalLayout` requires the exact `layoutId`, `terminalId`, and
creation receipt's `layoutUpdatedAt` and `terminalUpdatedAt` as
`expectedLayoutUpdatedAt` and `expectedTerminalUpdatedAt`. Immediately before
the effect, main revalidates the runtime lease, `panes.manage`, exact
DB-derived layout/surface scope, both CAS timestamps, exact workspace owner ID
and cwd, and the one-terminal/root-leaf shape. A mismatch in identity, owner,
target, cwd, or shape is non-enumerating `not_found`; either stale CAS value is
`conflict`. A sibling workspace with the same cwd is still a foreign owner.

Controlled deletion first validates both CAS values and the exact-owner/shape
constraints. It then performs native teardown outside a SQLite transaction and
finally issues a second dual-CAS database delete. A teardown failure preserves
the records. If the final database step fails after registry detachment, the
recoverable layout/terminal rows remain and the operation returns `partial` with
teardown accepted and `db.write` failed; it never claims rollback. After a
successful delete, renderer selection reconciliation returns a structurally
verified acknowledgement. If it is unavailable or invalid, the operation
returns `partial` with teardown and DB deletion receipts rather than reporting
that the layout still exists. Native destroy proves that teardown was accepted
and the surface registry was detached; it is not confirmation that the child
process has exited.

The trusted renderer panel/layout/terminal delete paths also route through
main-owned strict native teardown before removing persistence; destroy failure
blocks the database delete/cascade. The UI may edit or delete an agent-owned
layout; ownership constrains the MCP operation, not the trusted user interface.
A later MCP cleanup therefore returns `conflict` or non-enumerating `not_found`
when the UI has already changed or deleted either CAS-protected record.

Creation needs no pre-existing pane target in the runtime's resource scope. It
does not mint caller-supplied authority: the new exact layout/surface enters
main's DB-derived scope on the next request, and a deleted target falls out on
the next request. Settings → Orpheus Agent Tools may suppress either descriptor
without changing the default runtime permission or widening scope. Neither
operation introduces a per-call permission prompt.

Closing, archiving, or removing the owner workspace tears down every live pane
surface still identified by the persisted `agent_owner_workspace_id`. The
layout row may remain for later trusted-UI cleanup or remount, but lease
revocation cannot leave its process running. A trusted UI material takeover
transactionally clears `agent_owner_workspace_id` and bumps the layout revision:
layout dir/tree/position, terminal add/delete/command/position, or `autoStart`
changes transfer ownership; name-only edits preserve it. Owner-close cleanup
and the four-layout owner cap count only layouts that still carry that owner.

Renderer acknowledgements are correlated by request id and broker generation,
then structurally validated in main against the expected workspace or exact
layout/terminal target. A renderer loss after a native effect returns a
`partial` receipt containing only effects known to have occurred.

The focused Workbench/pane lifecycle verifier, node and web typechecks, and the
aggregate agentic regression suite pass for this source. The inventory tuple is
48 registered, 48 MCP, 48 default-exposed, 48 runtime-visible, and 5
automation-eligible operations. Packaged-live validation confirmed
Retina-correct terminal scale, colored output, direct observation through the
returned target, exact deletion, post-delete `not_found`, and preservation of
the workspace Claude terminal.
