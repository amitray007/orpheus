# Phase 6: Settings and Resources

**Status:** implemented and deterministically tested; core live MCP
read/patch paths validated, restart-required live path pending<br>
**Roadmap:** [roadmap.md](roadmap.md)<br>
**Interfaces:** [phase-06-interfaces.md](phase-06-interfaces.md)<br>
**Depends on:** [Phase 3: Workspace Orchestration](phase-03-workspace-orchestration.md)

## Outcome

Phase 6 publishes a deliberately small settings/resources surface through the
canonical control registry and managed MCP adapter:

- `settings.getEffective`;
- `settings.patchWorkspace`;
- `resources.listProjectMetadata`.

The phase preserves the existing global → project → workspace settings stack,
uses `composeClaudeLaunch` as the effective-launch authority, writes through the
existing workspace settings store, and preserves the existing
`recomputeDirty()` restart-to-apply behavior.

This contract is intentionally narrower than the renderer Settings UI. It
includes only values and metadata that can be exposed without granting access
to credentials, arbitrary environment/process configuration, shell execution,
or another project.

## Delivered allowlist

### Effective settings read

`settings.getEffective` returns:

- effective Claude `model`;
- effective Claude `effort`;
- each value's global value, project override, workspace override, and winning
  provenance;
- Orpheus `maxWorkspaceDepth` and `maxWorkspaceChildren` guardrails as
  read-only values;
- the workspace's current restart-to-apply dirty state;
- observation and per-layer update timestamps.

The effective model must equal `composeClaudeLaunch(...).model`. Effective
effort is derived from the composed `--effort` flag, with `auto` represented
when the flag is intentionally absent.

### Safe workspace write

`settings.patchWorkspace` accepts only:

- `model`: a bounded model identifier, or `null` to clear the workspace
  override;
- `effort`: one of the canonical `CLAUDE_EFFORT_VALUES`, or `null` to clear the
  workspace override.

The operation is self-only for MCP. It writes through
`updateClaudeWorkspaceSettings`, uses the existing effort reconciliation when
the model changes, calls `recomputeDirty`, and returns the freshly composed
effective values plus the resulting restart-to-apply state.

### Project resource metadata

`resources.listProjectMetadata` reads only the bound project and returns
metadata for:

- MCP servers: name and transport;
- hooks: event, matcher, and type;
- slash commands: name, description, allowed-tool names, and argument hint;
- subagents: name, description, tool names, and model label.

The result never includes resource bodies, frontmatter maps, commands,
arguments, environment, URLs, filesystem paths, file indexes, or raw source
objects. The domain readers resolve one explicit project and do not enumerate
or read every registered project's resource files. Project-relative resource
paths reject symlinked files/directories, each source file is capped at 1 MiB,
the response is capped at 256 resources, metadata arrays at 64 items, and
published strings at 512 characters. The response reports `truncated: true`
when sanitized resources exceed that cap. Unsafe, oversized, or unreadable
authoritative sources produce a stable `unavailable` result.

## Identity and policy

MCP access to all three operations requires a valid Phase 2 runtime lease.
The two Tier 0 reads additionally accept a server-resolved automation binding;
the workspace patch remains MCP-only.

- Reads may target the bound workspace/project or an explicitly named
  same-project workspace/project.
- Unknown and cross-project targets return the same non-enumerating
  `not_found`.
- Workspace settings mutation is self-only: an explicit `workspaceId` must
  equal the trusted binding's workspace.
- Ambient context, cwd, PID, and the app-global command token do not supply
  MCP identity or authority.
- Default managed runtime grants do not include any Phase 6 permission.
  Publication requires an injected exact grant.
- Main's automation policy grants only the two effect-free reads, at Tier 0,
  for the exact existing workspace/project scope. It never grants app scope or
  `settings.patchWorkspace`.

The permission vocabulary is:

| Permission | Covers |
| --- | --- |
| `settings.read` | Effective allowlisted settings and provenance |
| `settings.workspace.patch` | Self workspace model/effort override mutation |
| `resources.read` | Same-project sanitized resource metadata |

## Tier and effects

| Operation | Tier | Maximum declared effects |
| --- | ---: | --- |
| `settings.getEffective` | 0 | none |
| `resources.listProjectMetadata` | 0 | none |
| `settings.patchWorkspace` | 2 | `db.write`, `workspace.dirty.recompute` |

Reads are side-effect-free. Mutation is audited whether allowed, denied,
invalid, failed, or completed. Audit params are recursively redacted before
persistence. Error messages are stable and do not contain values read from
resource files, database exceptions, filesystem paths, or secrets.

## Secret boundary

The following are absent from discovery schemas, results, audit params, and
errors:

- API keys, auth tokens, runtime leases, cookies, credentials, and request
  headers;
- `customEnvVars`, arbitrary environment names/values, and auth/provider env;
- `customCliFlags`, raw flags, unrestricted settings JSON, and generic patch
  bags;
- `sourceZshrc`, `preLaunchSnippet`, shell overrides/prefixes, proxy values,
  permission rules, and permission-mode writes;
- MCP commands, args, env, URLs, and file paths;
- hook command strings and file/index addressing;
- slash-command/subagent bodies, body previews, raw frontmatter, and file paths;
- raw SQL, arbitrary paths, resource file contents, and internal exceptions.

Resource metadata strings pass through bounded secret-pattern filtering before
publication, including URL- and absolute-path-shaped values. This is defense
in depth; excluded source fields remain the primary boundary. Stored
model/effort values that cannot satisfy the public allowlist fail closed as
`unavailable` instead of being copied into a result or error.

## Explicit exclusions

Phase 6 does not implement:

- global or project settings writes;
- workspace permission-mode writes;
- arbitrary Orpheus UI settings mutation;
- MCP-server, hook, slash-command, subagent, or memory mutation;
- user/global resource enumeration;
- cross-project resource enumeration;
- Claude auto-memory or `CLAUDE.md` file discovery.

Memory resources remain excluded because the repository has no canonical,
scoped memory domain store with explicit ownership and secret filtering. Adding
a filesystem guess would violate the phase's domain-owner rule.

## Compatibility

- Existing renderer settings IPC and resource editors remain unchanged.
- Existing global/project/workspace stores remain authoritative.
- Existing MCP, hook, slash-command, and subagent list/edit UI remains.
- Existing CLI and offline reads remain unchanged.
- Phase 6 does not add a database migration; it reuses the Phase 3
  `control_audit` table.
- No user/global Claude configuration file is written by the control plane.

## Acceptance boundary

Deterministic verification must cover:

- strict schemas with `additionalProperties: false`;
- default-grant omission and exact injected-grant publication;
- self-only writes and non-enumerating same-project reads;
- model/effort parity with `composeClaudeLaunch`;
- provenance across global, project, and workspace layers;
- writes through the existing workspace settings store;
- restart-to-apply recomputation after mutation;
- project-scoped resource reads that do not touch another project;
- absence of every excluded field from schemas and results;
- recursive audit redaction and secret-pattern filtering;
- stable redacted errors and Phase 2/3 registry regressions.
- automation discovery/idempotency pairing, exact-scope default grants,
  cross-project denial, and workspace-patch exclusion.

The packaged integration batch verified exact scoped managed-MCP discovery,
`settings.getEffective`, sanitized `resources.listProjectMetadata`, and a
self-workspace effort patch with correlated request/audit ids and effects. The
test then restored the original workspace effort override to `high` and
confirmed both the override and effective value were `high`.

That restored result reported `restartRequired: false`, so the live batch did
not exercise a native restart-to-apply transition. That focused path remains
deterministic-only and must not be inferred from the successful patch/restore.
