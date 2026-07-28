# Identity and permissions

## Purpose

The agentic control plane needs a first-class answer to two questions:

1. **Who is calling?**
2. **What may that caller do to which Orpheus resource?**

Identity is established by the Orpheus main process from a runtime it launched or
explicitly admitted, not reconstructed from a directory, caller-supplied workspace
ID, or ambient environment. Existing CLI convenience remains, but **target
inference** is separate from **authentication and authorization**.

## Identity vocabulary

These identifiers are related, but they are not interchangeable.

| Identity | Lifetime and meaning | Important non-equivalences |
| --- | --- | --- |
| `projectId` | Persistent ID for a registered project root. A project owns many workspaces. | A matching `cwd` is not a project identity or grant. A Panes “Project” panel is not an Orpheus project. |
| `workspaceId` | Persistent ID for one Orpheus exploration unit. It owns a cwd, settings, lineage, one Claude surface, and zero or more Workbench terminals. | It is not a process, conversation, or native surface ID. |
| `claudeConversationId` | Stable Claude transcript/conversation UUID, currently `WorkspaceRecord.claudeSessionId`. It is pre-assigned at workspace creation and survives `--resume`. | It is not a live PID. A conversation may have no live runtime. |
| `runtimeId` | Orpheus-issued ID for one live execution instance, such as a Claude process or plain shell. It changes after restart. | PID is only observed runtime metadata; PIDs are recycled and must not be used as identity. |
| `surfaceId` | Opaque ID for one terminal presentation surface. A sticky surface can outlive or host more than one runtime over time. | It is not necessarily a workspace. It must not be parsed to infer authority. |

The native adapter currently uses keys such as a plain `workspaceId`,
`workbench:<workspaceId>:<terminalId>`, and
`pane:<layoutId>:<paneTerminalId>`. Those are internal routing keys. The control
plane exposes an opaque `surfaceId` and stores the adapter key in main-process
state; it does not make string parsing part of the public contract.

**Claude conversation** avoids the overloaded “session,” which currently means
both a transcript row and a live file under `~/.claude/sessions/<pid>.json`.

### Source-account metadata is not caller identity

The Home dashboard may return a GitHub login, provider `identityLabel`, auth-file
label, plan name, or similar source-account metadata. These values describe the
account or source from which Orpheus read data. They do not identify the caller,
bind a runtime, select a grant subject, or prove that the caller may access
account-wide data. Only main-resolved principal and runtime context establish
caller identity.

## Surface and shell distinctions

### Workspace Claude surface

A workspace owns one persistent libghostty surface whose command is
`orpheus-claude.sh`. Its normal identity graph is:

```text
project -> workspace -> Claude conversation
                     -> Claude runtime -> Claude surface
```

Hiding does not destroy the surface. Restarting Claude changes `runtimeId` and PID,
but not `workspaceId`, `claudeConversationId`, or necessarily `surfaceId`.

### Workbench terminal

A Workbench terminal is a plain interactive login shell at the owning workspace's
`cwd`. It does not run `orpheus-claude.sh`, does not create a second Claude
conversation, and does not participate in Claude activity status.

Its identity graph is:

```text
project -> workspace -> Workbench shell runtime -> Workbench surface
```

It may default workspace/project actions to its owner, but has no default
`claudeConversationId`; conversation-only actions require an explicit valid target.

### Panes terminal

Panes is an independent top-level feature. A pane belongs to a panel, layout, and
terminal record; its cwd is `PaneLayout.dir`. Even a panel whose kind is
`project` is not a row in Orpheus's `projects` table.

Its identity graph is:

```text
pane panel -> pane layout -> pane shell runtime -> pane surface
```

A pane has no default Orpheus workspace, project, or Claude conversation. Directory
matching may suggest a target, but cannot attach identity or grants.

## Trusted runtime context

When Orpheus launches a Claude runtime, Workbench shell, or pane shell, main
creates an immutable runtime binding:

```ts
type TrustedRuntimeContext = {
  runtimeId: string
  runtimeKind: 'claude' | 'workbench_shell' | 'pane_shell'
  surfaceId: string
  workspaceId: string | null; projectId: string | null
  claudeConversationId: string | null
  issuedAt: number
}
```

Main also issues a random runtime-scoped bearer lease. The server resolves it from
its own registry; callers do not send trusted identity fields. It expires with the
runtime, rotates on restart, and is never logged.

`pid`, `cwd`, environment, session files, and request parameters are corroborating
observations only. They may detect stale bindings but cannot create identity.

### Existing CLI compatibility

The current CLI remains useful:

- `--project` still selects a project by ID, name, or path.
- `ORPHEUS_WORKSPACE_ID` still supplies convenient workspace/project defaults.
- cwd-prefix matching still finds the most specific registered project.
- `sendCommand()` may continue auto-injecting `context.workspaceId`.
- the app-wide socket token continues proving access to the local command socket.

None is strong runtime authentication. `ORPHEUS_WORKSPACE_ID` is caller-controlled,
and same-user processes can read the app-wide token. A legacy request without a
runtime lease is an **unbound local CLI request**: inferred context selects a target
only, and grants use unbound-local policy.

Explicit targets override convenience defaults, never permission checks.

## `self` and default targets

`self.get` returns the server-resolved runtime binding, effective defaults, and
capability decisions. For all other actions:

1. An explicit target wins after existence, relationship, and grant validation.
2. A workspace-scoped action defaults to the bound `workspaceId`.
3. A project-scoped action defaults to the bound workspace's `projectId`.
4. A conversation-scoped action defaults only to a bound
   `claudeConversationId`.
5. A terminal action defaults to the caller's bound `surfaceId`.
6. From a Claude runtime, “my terminal” means its Claude surface unless the
   action explicitly asks for the workspace's Workbench terminal.
7. From a Workbench runtime, “my terminal” means that Workbench surface.
8. From a pane runtime, “my terminal” means that pane surface; no workspace or
   project is inferred.
9. A missing or ambiguous default fails closed with candidate IDs, never a
   guessed mutation.
10. Defaults never cross project boundaries. Existing self-close and
    self-archive guards remain enforced after target resolution.
11. Account/app-global source reads do not inherit workspace or project scope.
    They require an explicit account/app grant and, where more than one source
    account exists, an explicit source-account target.

On workspace creation, the bound workspace remains the default parent and its
project the default project. Cross-project creation requires an explicit grant.

## Capability contracts

Capabilities use versioned dotted names. Their meaning does not broaden in place;
new authority is introduced additively.

| Capability | Covers |
| --- | --- |
| `identity.read` | `self.get` and the caller's resolved identity graph |
| `projects.read` | Project metadata and listing |
| `workspaces.read` | Workspace metadata, status, lineage, and transcript-derived summaries |
| `workspaces.create` | Create or fork a workspace and apply creation-time settings |
| `workspaces.open` | Mount or focus a workspace |
| `workspaces.send` | Send text, keys, or submit to a Claude workspace surface |
| `workspaces.wait` | Subscribe to workspace completion or blocked states |
| `reviews.read` | Read local review comments |
| `reviews.resolve` | Change a local review comment's resolved state |
| `github.account.read` | Read a cached account-wide GitHub snapshot or contribution window |
| `github.account.refresh` | Explicitly refresh account-wide GitHub data through bounded source requests |
| `activity.read` | Read a cached app-global Claude activity snapshot or window |
| `activity.refresh` | Explicitly rescan the app-global Claude transcript source and update its cache |
| `providers.usage.read` | Read a cached provider-neutral usage snapshot |
| `providers.usage.refresh` | Explicitly probe provider sources and update the usage cache |
| `ui.workbench.control` | Open/focus Workbench UI and select or create its terminal |
| `terminals.control` | Send input or run a command in an authorized plain terminal |
| `terminals.read` | Read bounded authoritative terminal/session observations |
| `settings.read` | Read allowlisted effective workspace settings and provenance |
| `settings.workspace.patch` | Change workspace-scoped Claude settings |
| `resources.read` | Read sanitized same-project resource metadata |

`workspaces.send` and `terminals.control` are deliberately separate. The former
talks to Claude's interactive input; the latter controls a shell. Neither implies
the other.

The account-wide dashboard capabilities are future contracts and are not
published in Phase 2. Their `.read` capabilities are cache-only. Their
`.refresh` capabilities can carry materially broader effects and never inherit
authority from the read grant.

## Grants

A grant binds a capability to a principal and scope:

```ts
type Grant = {
  id: string
  subject: { runtimeId?: string; workspaceId?: string; kind?: 'unbound_local' }
  capability: string
  scope: { projectIds?: string[]; workspaceIds?: string[]
    surfaceIds?: string[]; accountIds?: string[]; appWide?: boolean
    selfOnly?: boolean }
  decision: 'allow' | 'ask' | 'deny'
  maxRiskTier: 0 | 1 | 2 | 3
  expiresAt: number | null
}
```

Runtime grants expire with the runtime. Workspace grants can survive restart but
re-bind only to a new trusted runtime. Deny wins; otherwise the most specific grant
wins. No match uses the capability's ask/deny default. Changing grants is tier 3.

### Delivered grant state

As of the 2026-07-28 current-source delta, a valid, current, main-observed
managed Claude runtime receives the complete registered runtime permission
vocabulary. Main still requires the same live binding, valid PID, matching
runtime/surface/workspace/project/conversation identity, and unrotated issuance
record. Missing, malformed, pending, dead, revoked, stale, replaced, mismatched,
or throwing state receives no production runtime authority.

Pane authority remains narrower than permission publication. Main derives the
runtime's exact layout and surface scope from current persisted pane state;
directory or cwd equality never supplies scope. Authorization rechecks that
scope immediately before an effect.

Settings → Orpheus Agent Tools persists category and per-tool exposure
preferences. Exposure is deny-only: disabling a tool removes discovery and
blocks invocation, while enabling it cannot add permissions, widen exact scope,
raise the allowed risk tier, or bypass operation policy. Effective exposure
changes increment a process-local catalog revision and notify connected MCP
bridges through `tools.listChanged`, so they do not require a runtime restart.
Before the automation-management descriptors landed on 2026-07-28, the
all-enabled deterministic snapshot contained 37 of 37 MCP-eligible descriptors;
the post-registration harness snapshot reports 46 registered, 46 MCP, 46
default-exposed, and 2 automation-eligible operations. These counts are dated
evidence, not a normative catalog contract.

The current vocabulary also includes `automations.manage`. Its nine
`automations.*` descriptors are MCP-only, require a trusted live
workspace-agent binding, and filter definitions/runs to the binding's exact
project and workspace. They never declare the `automation` surface, so an
automation cannot create, enable, delete, or retry another automation.

The earlier Phase 8 `Orpheus Dev` injected-grant run remains historical live
evidence for the former restricted default. It must not be read as the current
production permission model. There is still no user-editable grant store or
grant-administration UI; Agent Tools preferences only reduce exposure.

Automation authority is separate from runtime authority. Definitions cannot
grant themselves permissions. Main's fixed automation source permits only
`settings.getEffective` and `resources.listProjectMetadata`, both effect-free
Tier 0 queries with natural idempotency, against a server-resolved exact
workspace/project scope. App scope, mutations, and every other descriptor fail
closed.

The separate Phase 8 QA command credential is fixture authentication, not a
runtime or automation grant. It is accepted only together with the ordinary
command-socket token and cannot supply targets, operation ids, params, grants,
or SQL.

## Risk tiers

| Tier | Meaning | Examples |
| --- | --- | --- |
| 0 — observe | No durable or presentation state change | `self.get`, list projects, read status |
| 1 — present | Reversible UI or lifecycle presentation | Focus Workbench, mount/open an existing surface |
| 2 — act | Scoped mutation or arbitrary execution | Create workspace, resolve review, send Claude input, run a shell command |
| 3 — destructive or boundary-changing | Irreversible, broad, secret-bearing, or permission-changing | Archive/delete, force dirty teardown, widen grants, credential operations |

A shell command is at least tier 2 even when it looks read-only because shell
syntax can execute arbitrary code. A conservative classifier may raise a known
destructive command to tier 3, but an unknown command is never downgraded below
tier 2.

A cached dashboard read can remain Tier 0 because it performs no source probe or
durable write. A refresh is classified from its maximum declared effects, not
from its read-shaped result. Credential access or a fixed helper-process spawn
therefore cannot be hidden behind a Tier 0 query or an optional `force` flag.

## Declared effects and audit

Every action declares possible effects before execution, such as `ui.focus`,
`surface.mount`, `process.spawn`, `terminal.input`, `db.write`, or
`workspace.delete`. Authorization uses the resolved target and all declared
effects. Responses contain actual receipts, including partial success.

Dashboard refresh operations use precise effects such as `process.inspect`,
`credential.read`, `network.request`, `process.spawn`, and `cache.write`.
Cache-only reads declare none of them. Effects are bounded by fixed executables
and endpoints, timeouts, concurrency limits, response-size limits, and
source-specific policy. Antigravity's certificate-validation exception is
request-scoped to the hard-coded loopback language-server target and cannot
apply to provider cloud traffic.

Audits include request ID, time, trusted `runtimeId`, targets, capability, tier,
grant/decision, declared effects, receipts, and result. Tier 2/3 requests are
always persisted, including denied and failed attempts.

Arguments are structurally redacted; tokens are never stored. Commands and
terminal input default to hash, length, and safe summary rather than raw bytes.
Dashboard results, errors, receipts, and audits also exclude raw credentials,
tokens, and secret-bearing process arguments while preserving explicit stale,
unavailable, unsupported, and unknown states.

## Example `self.get`

```json
{
  "schemaVersion": 1,
  "principal": {
    "kind": "orpheus_runtime",
    "assurance": "runtime_lease",
    "runtimeId": "rt_01K12R9Y4WQH8NQ8A1T6C7E3PX"
  },
  "runtime": { "kind": "claude", "pid": 43192, "issuedAt": 1785070265000 },
  "surface": { "surfaceId": "surf_01K12R9Y7CF6QAZ9P3K2E8J5VN", "kind": "workspace_claude" },
  "workspace": {
    "workspaceId": "aa13bc35-8bf6-4ef8-a047-acde141dd0b7",
    "projectId": "42aee727-55f5-4a14-a900-538744cffc1b",
    "cwd": "/Users/maverick/code/projects/orpheus"
  },
  "project": { "projectId": "42aee727-55f5-4a14-a900-538744cffc1b", "name": "Orpheus" },
  "claudeConversation": { "claudeConversationId": "78e088a9-78e3-497c-928e-3a212cc07cf7" },
  "defaults": {
    "workspaceId": "aa13bc35-8bf6-4ef8-a047-acde141dd0b7",
    "projectId": "42aee727-55f5-4a14-a900-538744cffc1b",
    "surfaceId": "surf_01K12R9Y7CF6QAZ9P3K2E8J5VN"
  },
  "capabilities": {
    "allow": ["identity.read", "projects.read", "workspaces.read", "workspaces.wait"],
    "ask": ["workspaces.create", "workspaces.send", "ui.workbench.control", "terminals.control"],
    "deny": ["settings.workspace.patch"]
  }
}
```

## Example: “open my terminal and run a command”

For a request originating in a Claude workspace:

1. Main resolves the runtime lease; `self.get` identifies the workspace, project,
   Claude conversation, and Claude surface.
2. The intent explicitly chooses the workspace's **Workbench terminal**, because
   running a shell command must not type into Claude's prompt. A pane is never
   selected by cwd coincidence.
3. The control plane resolves or creates one Workbench shell surface owned by the
   same workspace and proposes:
   - `ui.workbench.control` at tier 1 with `ui.focus` and `surface.mount`;
   - `terminals.control` at tier 2 with `terminal.input` and `process.spawn`.
4. Grants are evaluated against the resolved workspace and surface. If
   `terminals.control` is `ask`, the user sees the exact command, cwd, target
   terminal, and expected effects. Approval is bound to this request or an
   explicitly chosen duration; it does not imply future terminal authority.
5. Main opens/focuses Workbench, starts the plain shell if needed, binds its new
   `runtimeId` and `surfaceId`, and sends the command to that surface. The
   Workbench runtime has no Claude conversation identity.
6. The result reports each effect separately: UI selected, surface mounted,
   shell started, input accepted. Terminal output remains in the terminal unless
   a separate read/stream capability is introduced.
7. The audit entry records both capability decisions and effect receipts, with
   command text hashed/redacted by default.

For a request originating in a Workbench shell, step 2 defaults to that same
surface. For a pane shell, “my terminal” defaults to the pane, and no workspace
ownership is invented.
