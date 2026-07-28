# Phase 6: Settings and Resources Interfaces

**Status:** implemented and deterministically tested; core live MCP
read/patch paths historically validated, restart-required live path pending.
Agent Tools exposure refresh is immediate and independent<br>
**Phase contract:** [phase-06-settings-resources.md](phase-06-settings-resources.md)

## Common constraints

- Every input is an object with `additionalProperties: false`.
- IDs are non-empty strings of at most 128 characters.
- A settings patch contains at least one allowlisted property.
- `null` clears an override; omission leaves it unchanged.
- Outputs contain no arbitrary record copied from a settings or resource file.
- MCP targets default only from trusted runtime identity; automation targets
  default only from a server-resolved exact scope.

## Catalog

| Operation | Kind | Permission | Tier | Scope |
| --- | --- | --- | ---: | --- |
| `settings.getEffective` | query | `settings.read` | 0 | same-project workspace |
| `settings.patchWorkspace` | mutation | `settings.workspace.patch` | 2 | self workspace |
| `resources.listProjectMetadata` | query | `resources.read` | 0 | same project |

All descriptors are version `1`. `settings.getEffective` allows MCP and
automation with natural idempotency. `resources.listProjectMetadata` and
`settings.patchWorkspace` remain MCP-only. Project metadata scanning uses a
five-second cache keyed by project and requested resource kinds, bounded to
32 entries and 2 MiB total.

## `settings.getEffective`

Input:

```ts
type GetEffectiveSettingsInput = {
  workspaceId?: string
}
```

Output:

```ts
type SettingProvenance<T> = {
  global: T
  projectOverride: T | null
  workspaceOverride: T | null
  effective: T
  source: 'global' | 'project' | 'workspace'
}

type GetEffectiveSettingsOutput = {
  schemaVersion: 1
  projectId: string
  workspaceId: string
  settings: {
    model: SettingProvenance<string>
    effort: SettingProvenance<ClaudeEffort>
  }
  orpheus: {
    maxWorkspaceDepth: number
    maxWorkspaceChildren: number
  }
  restartRequired: boolean
  source: 'composeClaudeLaunch'
  observedAt: number
  updatedAt: {
    global: number
    project: number
    workspace: number
  }
}
```

The effective model and effort are checked against the canonical composed
launch, not independently inferred for publication.

## `settings.patchWorkspace`

Input:

```ts
type PatchWorkspaceSettingsInput = {
  workspaceId?: string
  patch: {
    model?: string | null
    effort?: ClaudeEffort | null
  }
}
```

Model identifiers are trimmed, 1–255 characters, and restricted to letters,
digits, `.`, `_`, `:`, `/`, and `-`. `effort` uses the repository's canonical
`CLAUDE_EFFORT_VALUES`.

Output:

```ts
type PatchWorkspaceSettingsOutput = {
  schemaVersion: 1
  requestId: string
  operationId: 'settings.patchWorkspace'
  projectId: string
  workspaceId: string
  applied: {
    model?: string | null
    effort?: ClaudeEffort | null
  }
  effective: GetEffectiveSettingsOutput
  restartRequired: boolean
  effects: Array<{
    effect: 'db.write' | 'workspace.dirty.recompute'
    status: 'applied'
  }>
  auditId: string
}
```

The MCP target is always the bound workspace. A different explicit workspace
returns `not_found`, without revealing whether it exists.

## `resources.listProjectMetadata`

Input:

```ts
type ListProjectResourceMetadataInput = {
  projectId?: string
  kinds?: Array<'mcp_server' | 'hook' | 'slash_command' | 'subagent'>
}
```

`kinds` contains 1–4 unique values. Omission returns all delivered kinds.

Output:

```ts
type ListProjectResourceMetadataOutput = {
  schemaVersion: 1
  projectId: string
  source: 'project-files'
  observedAt: number
  truncated: boolean
  resources: Array<
    | {
        kind: 'mcp_server'
        source: 'project'
        projectId: string
        name: string
        transport: 'stdio' | 'http' | 'sse' | 'unknown'
      }
    | {
        kind: 'hook'
        source: 'project'
        projectId: string
        event: string
        matcher: string | null
        type: string
      }
    | {
        kind: 'slash_command'
        source: 'project'
        projectId: string
        name: string
        description: string | null
        allowedTools: string[] | null
        argumentHint: string | null
      }
    | {
        kind: 'subagent'
        source: 'project'
        projectId: string
        name: string
        description: string | null
        tools: string[] | null
        model: string | null
      }
  >
}
```

Ordering is deterministic by kind and then the resource's stable visible
fields. Duplicate hooks remain separate entries. Results contain at most 256
resources; metadata arrays contain at most 64 strings; metadata strings contain
at most 512 characters. `truncated` is true when additional sanitized resources
were omitted by the 256-item response cap. Project-relative resource files and
directories must not traverse a symlink, and individual source files are capped
at 1 MiB.

## Stable errors

| Code | Meaning |
| --- | --- |
| `invalid` | Unknown field, malformed model/effort, empty patch, duplicate kind, or bound violation |
| `not_found` | Unknown or cross-project target, including a non-self mutation target |
| `forbidden` | Invalid runtime permission, disabled exposure, or failed risk-tier policy |
| `unavailable` | The canonical settings/resource owner cannot produce an authoritative result |
| `failed` | Redacted unexpected internal failure |

Errors never include resource contents, paths, shell commands, environment
values, tokens, or database/filesystem exception text.
