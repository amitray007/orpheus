# Phase 4: Workbench and Pane Interfaces

All descriptors are version 1, use `additionalProperties: false`, and are
published only to renderer IPC and managed MCP.

```ts
type Id = string // 1..128 characters
type RelativePath = string // normalized POSIX, 1..4096 UTF-8 bytes

type WorkbenchGetStateInput = {}
type WorkbenchSelectTabInput = { tab: "git" | "terminal" | "files" }
type WorkbenchOpenFileInput = {
  path: RelativePath
  mode?: "viewer" | "preview"
}
type WorkbenchOpenDiffInput = {
  target:
    | { kind: "working-tree-file"; path: RelativePath }
    | { kind: "local-review"; reviewId: Id }
}

type PaneTargetInput = { layoutId: Id }
type PaneTerminalTargetInput = { layoutId: Id; terminalId: Id }
```

No Workbench input includes `workspaceId`; main derives it from the runtime
lease. Relative paths reject absolute paths, empty segments, `.`, `..`, NUL,
backslashes, and paths outside the bound workspace after canonical resolution.

```ts
type WorkbenchStateV1 = {
  schemaVersion: 1
  workspaceId: Id
  observedAt: number
  source: "renderer-live"
  workbench: {
    state: "dormant" | "open" | "expanded"
    activeTab: "git" | "terminal" | "files"
  }
  file: { path: string; mode: "viewer" | "preview" } | null
  diff: {
    kind: "working-tree-file" | "local-review"
    path: string
    reviewId: string | null
  } | null
}

type PaneStateV1 = {
  schemaVersion: 1
  observedAt: number
  source: "renderer-live"
  layoutId: Id
  panelId: Id
  selected: boolean
  focusedTerminalId: Id | null
  terminals: Array<{
    terminalId: Id
    selected: boolean
    desiredState: "running" | "stopped"
  }>
}
```

`desiredState` is renderer intent, not authoritative native liveness. Mutations
return the Phase 3 receipt envelope with actual effect receipts and audit id.
Unknown and unauthorized pane resources both return non-enumerating
`not_found`.

Renderer acknowledgements are correlated by request id and broker generation,
then structurally validated in main against the expected workspace or exact
layout/terminal target. A renderer loss after a native effect returns a
`partial` receipt containing only effects known to have occurred.
