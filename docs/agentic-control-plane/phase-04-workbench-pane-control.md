# Phase 4: Workbench and Pane Control

**Status:** implemented and deterministically tested; live-app validation pending
**Depends on:** Phase 3 workspace orchestration

## Outcome

Phase 4 adds semantic, self-scoped control over the calling runtime's Workbench
and explicitly granted persisted pane layouts. Public operations never accept a
DOM selector, coordinate, accessibility label, key sequence, command, cwd, or
workspace id.

The frozen operation set is:

- `workbench.getState`, `workbench.selectTab`, `workbench.openFile`,
  `workbench.openDiff`;
- `panes.getState`, `panes.selectLayout`, `panes.startTerminal`,
  `panes.stopTerminal`, `panes.focusTerminal`.

Workbench targets are resolved only from a trusted runtime lease. Panes v2 is
app-global, not workspace-owned, so pane operations additionally require exact
server-issued layout and surface grants. Directory equality is never identity.

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

Phase 4 publishes UI intent only. Phase 5 owns authoritative terminal phase,
readiness, activity, output tails, timestamps, and subscriptions. Phase 6 owns
layout definitions, commands, cwd, names, auto-start, preferences, settings,
models, and environment.

## Permission and effects

| Operation | Permission | Tier | Maximum effects |
| --- | --- | ---: | --- |
| `workbench.getState` | `ui.workbench.control` | 0 | none |
| `workbench.selectTab` | `ui.workbench.control` | 1 | `ui.present` |
| `workbench.openFile` | `ui.workbench.control` | 1 | `filesystem.read`, `ui.present` |
| `workbench.openDiff` | `ui.workbench.control` | 1 | `git.read`, `process.spawn`, `ui.present` |
| `panes.getState` | `ui.workbench.control` | 0 | none |
| `panes.selectLayout` | `ui.workbench.control` | 1 | `db.write`, `ui.present` |
| `panes.startTerminal` | `terminals.control` | 2 | `surface.mount`, `process.spawn` |
| `panes.stopTerminal` | `terminals.control` | 2 | `surface.destroy`, `process.terminate` |
| `panes.focusTerminal` | `terminals.control` | 1 | `ui.present`, `ui.focus` |

Default runtime grants do not include either new permission. Tests and future
user policy inject them explicitly.

`openDiff` v1 supports only working-tree files and Orpheus local review targets.
PR/GitHub targets are excluded because opening them may cross account and
network authority.
