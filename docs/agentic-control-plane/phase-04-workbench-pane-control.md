# Phase 4: Workbench and Pane Control

**Status:** existing controls implemented and deterministically tested; core
live MCP/renderer controls validated. The positive workspace-terminal
create/observe/delete path was packaged-live validated on 2026-07-28; remaining
negative and recovery paths are deterministic-only.<br>
**Roadmap:** [roadmap.md](roadmap.md)<br>
**Interfaces:** [phase-04-interfaces.md](phase-04-interfaces.md)<br>
**Depends on:** Phase 3 workspace orchestration

## Outcome

Phase 4 adds semantic, self-scoped control over the calling runtime's Workbench
and exact server-resolved persisted pane layouts. Public operations never accept
a DOM selector, coordinate, accessibility label, key sequence, cwd, or
workspace id. The workspace-terminal provisioning operation has one deliberately
bounded exception for an optional one-shot initial command.

The frozen operation set is:

- `workbench.getState`, `workbench.selectTab`, `workbench.openFile`,
  `workbench.openDiff`;
- `panes.getState`, `panes.selectLayout`, `panes.startTerminal`,
  `panes.stopTerminal`, `panes.focusTerminal`;
- `panes.createWorkspaceTerminal`, `panes.deleteTerminalLayout`.

Workbench targets are resolved only from a trusted runtime lease. Panes v2 is
app-global, not workspace-owned, so pane operations additionally require exact
layout and surface scope derived by main from current persisted pane state.
Directory equality is never identity.

## Boundary

Main owns identity, policy, validation, native effects, receipts, and a bounded
renderer command/ack broker. Renderer adapters apply semantic store transitions
and acknowledge observable completion. Missing, reloading, crashed, or replaced
renderers return `unavailable`; they never produce silent success.

Runtime permissions and exact pane grants are revalidated immediately before
effects, after any same-target queue wait. Workbench paths are canonically
contained in the leased workspace and filesystem reads reject symlink escapes.
Mutations are serialized per Workbench workspace or pane layout, and successful
or partial effects are durably audited with recursively redacted parameters.

The original Phase 4 operations publish UI intent only. Phase 5 owns
authoritative terminal phase, readiness, activity, output tails, timestamps,
and subscriptions. Phase 6 owns general layout definitions, commands, cwd,
names, auto-start, preferences, settings, models, and environment. The two
workspace-terminal lifecycle operations are a deliberately narrow Phase 4
exception: main owns their fixed durable shape so an agent can provision and
clean up its own usable pane without receiving general pane CRUD.

## Permission and effects

| Operation                       | Permission             | Tier | Maximum effects                                                                         |
| ------------------------------- | ---------------------- | ---: | --------------------------------------------------------------------------------------- |
| `workbench.getState`            | `ui.workbench.control` |    0 | none                                                                                    |
| `workbench.selectTab`           | `ui.workbench.control` |    1 | `ui.present`                                                                            |
| `workbench.openFile`            | `ui.workbench.control` |    1 | `filesystem.read`, `ui.present`                                                         |
| `workbench.openDiff`            | `ui.workbench.control` |    1 | `git.read`, `process.spawn`, `ui.present`                                               |
| `panes.getState`                | `ui.workbench.control` |    0 | none                                                                                    |
| `panes.selectLayout`            | `ui.workbench.control` |    1 | `db.write`, `ui.present`                                                                |
| `panes.startTerminal`           | `terminals.control`    |    2 | `surface.mount`, `process.spawn`                                                        |
| `panes.stopTerminal`            | `terminals.control`    |    2 | `surface.destroy`, `process.terminate`                                                  |
| `panes.focusTerminal`           | `terminals.control`    |    1 | `ui.present`, `ui.focus`                                                                |
| `panes.createWorkspaceTerminal` | `panes.manage`         |    3 | `db.write`, `surface.mount`, `process.spawn`, `shell.execute`, `ui.present`, `ui.focus` |
| `panes.deleteTerminalLayout`    | `panes.manage`         |    3 | `surface.destroy`, `process.terminate`, `db.write`, `ui.reconcile`                      |

Current valid, main-observed live runtimes receive all three permissions by
default. Invalid or stale runtime identity fails closed, and targeted pane calls
still require exact DB-derived layout/surface scope immediately before effects.
Settings → Orpheus Agent Tools may suppress discovery/invocation but cannot
widen that scope. There is no Orpheus per-call permission prompt. Claude Code
may independently prompt before invoking an MCP tool according to its own
permission mode; that does not change Orpheus exposure, grants, or exact-scope
policy.

`openDiff` v1 supports only working-tree files and Orpheus local review targets.
PR/GitHub targets are excluded because opening them may cross account and
network authority.

## Dedicated self-workspace pane lifecycle

`panes.createWorkspaceTerminal` is authorized from the trusted self lease. The
caller cannot supply a workspace, project, cwd, panel, split tree, position, or
auto-start choice. Main reads the exact `WorkspaceRecord.cwd`, creates one
layout plus terminal plus root leaf atomically in the built-in `General` panel,
persists the exact trusted workspace ID as
`agent_owner_workspace_id`, forces `autoStart` off, and enforces that panel's
12-terminal cap plus a four-layout cap for the exact owner workspace.

Optional labels are trimmed non-empty strings of at most 128 characters. The
optional `initialCommand` is NUL-free and limited to 8192 UTF-8 bytes. Main
never persists it: the created terminal stores an empty command, and a dedicated
provisioning start port carries the value ephemerally into at most one native
mount attempt. Failure or restart cannot replay it. It is never returned or
logged and is represented in control audit only by SHA-256 plus byte length.
Ordinary user-created pane commands remain intentionally persistent and are not
consumed by this path.

Creation returns the exact layout, panel, terminal, layout-update timestamp, and
terminal-update timestamp plus a canonical
`observationTarget: { kind: "pane", layoutId, paneId: terminalId }` that can be
passed directly to `terminals.getOutputTail`; `panelId` is never a terminal
observation identifier. Durable creation, one-shot ephemeral start, renderer
presentation, and native focus are separate receipt stages. The pre-render
bootstrap mount and the existing auto-start/sidebar-start background mounts use
the current BrowserWindow display scale factor so a retained native surface
matches PaneCell's later `devicePixelRatio` handoff. Native visibility is not
inferred from `ui.present`: that receipt confirms only the renderer's semantic
layout and terminal selection acknowledgement, while `surface.mount` records
native mount acceptance. Native focus has no authoritative
acknowledgement, so `ui.focus` is reported
`skipped`/unconfirmed rather than `applied`; that alone does not make the result
partial. Because there is no shell-execution acknowledgement, `shell.execute`
is not reported `applied` merely because an initial command was handed to the
first spawn. If a later stage fails, the response reports only effects known to
have occurred; the caller can use the returned IDs and both CAS timestamps to
observe or clean up the durable result.

`panes.deleteTerminalLayout` accepts only the exact layout ID, terminal ID, and
matching `expectedLayoutUpdatedAt` and `expectedTerminalUpdatedAt` CAS values.
It rechecks exact current scope, the exact bound workspace owner ID, the
workspace cwd, and a one-terminal root-leaf shape. Deletion preflights both CAS
values, performs native teardown outside a SQLite transaction, then issues a
final dual-CAS delete. Teardown failure preserves durable state. If the final
database delete fails after detachment, the recoverable rows remain and the
receipt is `partial` with teardown accepted and `db.write` failed; it does not
claim rollback. Native destroy proves accepted teardown and registry detachment,
not confirmed child-process exit. A foreign owner, including a sibling
workspace with the same cwd, receives generic `not_found`. Renderer selection
reconciliation occurs after a successful delete, is structurally verified, and
can produce a truthful `partial` receipt without undoing the completed
teardown/delete.

Existing renderer panel/layout/terminal deletes also perform native teardown
before persistence removal, and a destroy failure blocks the database
delete/cascade. The trusted UI may edit or delete an agent-owned layout; exact
ownership and the dedicated shape constrain MCP cleanup only. A later MCP
delete returns `conflict` or non-enumerating `not_found` if the UI changed or
removed a CAS-protected layout or terminal first.

Creation does not trust or extend ambient scope. The new DB-backed exact
layout/surface scope becomes available on the next request; deletion removes it
from the next request's derived scope.

Owner-workspace close, archive, or removal tears down every live pane surface
still carrying that workspace's persisted `agent_owner_workspace_id`. The
layout row may remain for later trusted-UI cleanup or remount, but no pane
process may survive lease revocation. Material trusted-UI edits transactionally
clear the owner ID and bump the layout revision: changing layout
dir/tree/position, adding or deleting a terminal, changing terminal
command/position, or toggling `autoStart` transfers the layout to user
ownership. Name-only edits preserve agent ownership. Owner-close teardown and
the four-layout cap apply only while the owner ID remains.

## Validation record

The historical packaged integration batch exercised the then-injected exact QA
grant through managed MCP and a real renderer acknowledgement. It read Workbench and pane state,
selected Files and Git, opened a workspace file and its working-tree diff,
selected the granted layout, and started, focused, and stopped the granted pane
terminal. Completed mutation receipts carried correlated request/audit ids and
applied effect receipts. No coordinates, selectors, accessibility scripting,
or generic key simulation were used.

That live batch did not force renderer loss or an unavailable/partial
acknowledgement. Those negative paths remain covered by deterministic harnesses
only.

The two dedicated lifecycle operations above were added after that historical
batch. The focused Workbench/pane lifecycle verifier, node and web typechecks,
and aggregate agentic harness pass. The aggregate harness reports 48
registered, 48 MCP, 48 default-exposed, 48 runtime-visible, and 1
automation-eligible operation.

On 2026-07-28, a fresh packaged build exposed all 48 tools. Two
`panes.createWorkspaceTerminal` calls produced visible QA layouts; one rendered
RED/GREEN initial-command output followed by an interactive zsh at normal
Retina scale. The returned
`observationTarget: { kind: "pane", layoutId, paneId }` was passed unchanged to
`terminals.getOutputTail` and returned that output. Both layouts were then
removed with their exact layout/terminal CAS timestamps. The deleted targets
returned `not_found`, while the workspace Claude terminal remained available.
This confirms the positive packaged lifecycle, scale handoff, observation
handoff, scope removal, and isolation paths. Capacity, conflict, partial
failure, ownership transfer, and owner-lifecycle teardown remain
deterministic-only.
