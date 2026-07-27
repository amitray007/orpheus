# Phase 5: Terminal Observability

**Status:** implemented and deterministically tested; packaged native and live managed MCP
validation deferred to the batched integration pass<br>
**Roadmap:** [roadmap.md](roadmap.md)<br>
**Depends on:** [Phase 2: Self Identity + Read-only MCP](phase-02-self-identity-readonly-mcp.md)
and the Phase 3 same-project policy contract

## Outcome

Phase 5 adds an observation-only terminal/session service behind the canonical
control registry and managed MCP adapter. It observes Orpheus's existing
main-process/native registries, Claude session files, SQLite metadata, and
bounded Claude JSONL readers. It does not create another terminal emulator,
capture presentation pixels, or infer text that Orpheus does not receive.

The frozen operation set is:

- `terminals.list`;
- `terminals.get`;
- `terminals.getClaudeSession`;
- `terminals.getOutputTail`;
- `terminals.subscribe`.

All five operations are version `1`, Tier 0 queries requiring
`terminals.read`. Inputs are strict objects with
`additionalProperties: false`. Managed MCP callers use the Phase 2 runtime
lease and may observe only their own terminal or workspace/workbench terminals
whose owning workspace resolves to the caller's project. Pane terminals have
no Orpheus project identity and are therefore self-only; directory coincidence
never grants access.

## Explicit exclusions

Phase 5 does not:

- send input, keys, commands, signals, or terminal-control sequences;
- mount, focus, hide, restart, stop, or destroy a surface;
- write settings, resources, SQLite rows, transcripts, or pane definitions;
- publish arbitrary shell execution or legacy low-level terminal steering;
- scrape renderer state, DOM nodes, accessibility state, or screenshots;
- use OCR or synthesize terminal text from titles, activity, or transcripts;
- claim that a Claude transcript is a PTY output tail;
- expose environment variables, runtime leases, tokens, auth material, or
  internal native routing keys.

## Identity and targets

Public terminal ids are opaque strings issued by main. The target alternatives
are:

```ts
type TerminalTarget =
  | { kind: 'workspace_claude'; workspaceId?: string }
  | { kind: 'workbench'; workspaceId: string; terminalId: number }
  | { kind: 'pane'; layoutId: string; paneId: string }
```

An omitted `workspace_claude.workspaceId` defaults only to the trusted runtime
workspace. Workbench targets resolve their workspace in SQLite and must match
the trusted project. Pane targets resolve the persisted layout/terminal and
are authorized only when they are the trusted runtime's exact surface. Unknown
and unauthorized targets both return non-enumerating `not_found`.

`terminals.list` returns the caller's same-project Claude terminals and
currently registered Workbench surfaces. It returns a pane only for an exact
pane-bound caller. It never lists panes by cwd matching.

## Observation envelope

Every observation, including explicit absence, uses:

```ts
type TerminalObservation<T> = {
  value: T | null
  source:
    | 'live'
    | 'sqlite'
    | 'native-surface-registry'
    | 'claude-session-file'
    | 'claude-jsonl'
    | 'configured-runtime'
    | 'authoritative-text-stream'
  observedAt: number
  sourceUpdatedAt: number | null
  freshness: 'live' | 'current' | 'stale' | 'offline' | 'unknown'
  availability: 'available' | 'unavailable' | 'unsupported' | 'offline'
  reason?: string
}
```

`unavailable` means the source is supported but no authoritative value exists
now. `unsupported` means Orpheus has no authoritative source for that field.
`offline` means persisted information remains readable while its live owner is
not running. `stale` is never silently presented as live.

## `terminals.list`

Input:

```ts
type ListTerminalsInput = {}
```

Output is one observation containing at most 256 summaries. Each summary
contains the opaque terminal id, kind, owning workspace/project when one
exists, and whether an authoritative native surface is currently registered.
If the bound project has more than 256 terminals, the result sets
`truncated: true`; enumeration never grows without bound.

## `terminals.get`

Input:

```ts
type GetTerminalInput = {
  target?: TerminalTarget // defaults to bound terminal
}
```

The returned snapshot has separately sourced fields:

- lifecycle and native phase (`none`, `hidden`, `attached`, `visible`, or
  `freeing`);
- running and readiness state;
- Claude workspace activity when applicable;
- configured command and cwd;
- Claude conversation/runtime/session metadata when applicable.

Plain Workbench and pane shells do not acquire Claude activity or conversation
identity. Their Claude-only fields return `unsupported`, not fabricated idle
or empty values. A missing native surface may still return persisted
configuration with `freshness: "offline"`.

## `terminals.getClaudeSession`

Input:

```ts
type GetClaudeSessionInput = {
  workspaceId?: string
  transcriptLimit?: number // integer 1..50; default 20
  includeToolActivity?: boolean // default false
}
```

The operation is workspace-Claude-only. It returns the authoritative session
file metadata plus the existing bounded transcript and last-turn
observations. Transcript reads retain Phase 2's 4 MiB scan cap and 64 KiB
per-turn text cap. This operation cannot request an arbitrary path or a larger
scan and never treats transcript content as terminal output.

## `terminals.getOutputTail`

Input:

```ts
type GetOutputTailInput = {
  target?: TerminalTarget
  maxBytes?: number // integer 1..65_536; default 16_384
  maxLines?: number // integer 1..200; default 80
}
```

The output tail is available only from an explicitly registered authoritative
UTF-8 text-stream provider. Providers must enforce both byte and line bounds
before returning and report truncation. The current libghostty EXEC backend
does not provide Orpheus with PTY output bytes, so current native surfaces
return `availability: "unsupported"` with a null value. No transcript, OSC
title, screenshot, renderer, or OCR fallback exists.

## `terminals.subscribe`

Input:

```ts
type SubscribeTerminalsInput = {
  target?: TerminalTarget
  afterRevision?: number // non-negative integer cursor
  timeoutMs?: number // integer 1..25_000; default 25_000
  maxEvents?: number // integer 1..100; default 50
}
```

Without `afterRevision`, the service captures a starting revision, builds the
authorized snapshot, and returns it with all matching events committed after
that starting revision. The returned cursor is the journal revision after
that replay. A transition during snapshot construction is therefore replayed
and cannot fall between snapshot and subscription.

With `afterRevision`, the call returns matching events immediately or
long-polls for at most 25 seconds. Events contain terminal id, revision,
event kind, observed time, source, and the new authoritative state fragment.
The journal retains at most 512 events and each response at most 100. At most
64 long-poll waiters are retained. If a cursor predates the bounded journal,
the response sets `resyncRequired: true` and includes a fresh snapshot using
the same race-free sequence.

Subscriptions cover lifecycle/native phase, runtime/session, readiness, and
Claude activity transitions emitted by the authoritative main-process stores.
Transcript contents are read on demand and are not streamed as terminal
events.

## Source mapping

| Field | Authority |
| --- | --- |
| Workspace and pane configuration | SQLite domain stores |
| Workbench shell command/cwd | Main's configured runtime behavior plus owning workspace |
| Surface existence and phase | Main native-surface registries plus `getSurfacePhase` |
| Claude runtime identity/pid | Runtime lease registry corroborated by session files |
| Claude running/readiness/raw status | `sessionState.ts` |
| Orpheus activity | `orpheusNotify.ts` committed status store |
| Transcript and last turn | Existing bounded Claude JSONL reader |
| Output tail | Registered authoritative text-stream provider only |

## Deterministic acceptance

The Phase 5 verification harness must cover:

1. exact catalog ids, Tier 0 metadata, `terminals.read`, and strict schemas;
2. trusted self defaults and same-project/non-enumerating target denial;
3. pane self-only policy without cwd-derived authority;
4. native lifecycle, runtime, readiness, activity, command/cwd, and Claude
   session provenance;
5. explicit unavailable, unsupported, stale, and offline results;
6. bounded terminal lists, transcript scans, per-turn text, output requests,
   journal size, response event count, waiter count, and timeout;
7. unsupported output tails when no authoritative text provider exists;
8. byte/line truncation when a fake authoritative provider is injected;
9. initial snapshot plus replay when a transition occurs during snapshot
   construction;
10. normal long-poll delivery, timeout, filtered events, cursor overflow, and
    resynchronization;
11. no renderer, OCR, screenshot, settings-write, terminal-input, shell
    execution, or secret-bearing imports in the observation core.

Packaged native behavior and live managed MCP discovery are deferred to the
batched integration pass. Static or deterministic verification must not be
reported as live app validation.

## Rollback

Rollback removes the five descriptors, observation service, event wiring, and
verification/doc files. It requires no database migration or user-data
cleanup.
