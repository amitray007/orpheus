# Orpheus — Quick Actions Specification

**Status:** Draft · 2026-04-18
**Scope:** Behavior spec for the Quick Actions footer strip (Wireframe 4). Defines how each action executes — not what the UI looks like (that's in `docs/wireframes/wireframes-v0.5.md`).
**Companion specs:** `docs/specs/architecture.md` (self-drive CLI + subprocess manager), `docs/wireframes/wireframes-v0.5.md` (Wireframe 4 footer).

---

## Why this spec exists

Quick Actions look like a uniform row of `[ /fork ]`, `[ /compact ]`, `[ /resume ]` buttons, but they do **fundamentally different things** under the hood. Some manipulate Orpheus state (spawn tabs, create splits, fork sessions); others just inject text into Claude's conversation as if the user typed it. Without classifying them, the implementation drifts into conditionals everywhere. This spec establishes the two modes (plus a hybrid) and gives each a clean execution path.

---

## Three execution modes

### Mode A — Orchestration
The action manipulates **Orpheus state** — creates tabs, spawns terminals, forks sessions, splits panes, creates spaces. Executed by the Orpheus core via the self-drive CLI (`orpheus` binary) or direct internal call. Claude Code is not notified; the user sees a new UI artifact appear.

### Mode B — Inject
The action is **text injected into the active terminal's stdin + Enter**. Claude Code receives and processes it as if the user typed it. No Orpheus state change; the conversation just moves forward with whatever the injected command does.

### Mode C — Hybrid
The action first performs orchestration, then injects text into the resulting terminal. Example: "resume session X in a new split" = create split (A) + inject `claude --resume <id>` in the new terminal (B). Hybrid is implemented as A then B in sequence.

---

## Default catalog (v0)

| Action | Mode | Behavior |
|---|---|---|
| `/fork` | **A (orchestration)** | Spawn a new Claude session as a new tab in the current space, forking the current tab's session at its latest message |
| `/split` | A | Split the current tab horizontally; open a new shell in the new pane |
| `/split-v` | A | Split vertically |
| `/new-space` | A | Create a new space in the current project |
| `/pin` | A | Toggle pin on current project or session |
| `/archive` | A | Archive the current space |
| `/compact` | **B (inject)** | Send `/compact` as user message — Claude Code summarizes and trims context |
| `/clear` | B | Send `/clear` — Claude Code resets conversation context |
| `/memory` | B | Send `/memory` — Claude Code manages auto-memory |
| `/plugins` | B | Send `/plugins` — Claude Code lists/manages plugins |
| `/skill <name>` | B | Send `/skill <name>` — invoke a named CC skill |
| `/resume` | **C (hybrid)** | Orchestration: open resume picker modal. User picks. Hybrid step: spawn new terminal with `claude --resume <id>` in current space |
| `/resume-split` | C | Split current tab + spawn `claude --resume <id>` in new pane |

User-configurable actions (post-v0 per `docs/future-scope.md` "Per-space configuration overrides") can define custom actions in each mode.

---

## Technical implementation

### Mode A — Orchestration (`/fork` as worked example)

**Behavior:** user clicks `/fork` in Quick Actions → Orpheus creates a new tab in the current space. The new tab holds a forked Claude session whose conversation history matches the original up to the fork point, but whose future messages diverge.

**Steps:**

1. **Identify the current session.** Active tab is `[ *claude ]` in the current space. Orpheus state holds the tab's `cc_session_id` (from the `terminals` table — see `architecture.md` Persistence schema).
2. **Spawn a new terminal** in the current space with command:
   ```
   claude --resume <session_id> --fork-session
   ```
   The `--fork-session` flag (native CC flag, confirmed in `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-16-2343-research-claude-code-surface.md`) creates a new session ID, preserves history up to that point, and the original session is untouched.
3. **Register the new terminal** in Orpheus's SQLite — new row in `terminals` table with `space_id` = current space, `cc_session_id` = the freshly-minted UUID (captured from CC's stream-json output or read from `~/.claude/projects/*.jsonl` after spawn).
4. **Render new tab** in Row A of the tab strip. Focus shifts to it.
5. **Both tabs live concurrently.** User can switch between them; each has independent future.

**Alternate gesture (deferred):** `/fork-split` could open the fork in a split pane of the current tab rather than a new tab. Same logic, different layout target.

### Mode B — Inject (`/plugins` as worked example)

**Behavior:** user clicks `/plugins` → Orpheus types `/plugins` into the active terminal's PTY stdin and presses Enter. Claude Code handles it natively.

**Steps:**

1. **Identify active terminal's PTY handle.** From Orpheus state, get the current active terminal's file descriptor / PTY reference.
2. **Write to PTY stdin:**
   ```
   PTY.write("/plugins\n")
   ```
   Or for commands with arguments: `"/fix-issue 123\n"`.
3. **Done.** Claude Code processes the user message like any other input. Orpheus doesn't need to wait for or parse the response — the chat viewer reflects it normally.

**Caveat:** injected commands should respect any pending input the user was typing. If the user's cursor has partial text, Orpheus should prepend or queue rather than clobber. Implementation detail: check terminal buffer state before injection.

### Mode C — Hybrid (`/resume-split` as worked example)

**Behavior:** user clicks `/resume-split` → modal opens with session picker → user picks session → Orpheus splits current tab vertically and spawns `claude --resume <id>` in the new pane.

**Steps:**

1. **Orchestration (A):** open session picker modal (Wireframe 5 Sessions browser, or a lighter picker for resume-only).
2. **User selects** a session from the list.
3. **Orchestration continues (A):** split current tab vertically; create a new terminal in the new pane.
4. **Spawn command (B):** the new terminal's command is `claude --resume <session_id>` (not a user-message inject; the terminal starts with this command directly).
5. **Register new terminal** in DB; update UI.

Hybrid actions are essentially sequences of Mode A and Mode B steps chained.

---

## Action definition schema

Each quick action is a config object. Orpheus ships defaults; users can add custom actions via settings.

```json
{
  "id": "fork",
  "label": "/fork",
  "mode": "orchestration",
  "implementation": {
    "kind": "spawn_forked_session",
    "target": "new_tab"
  },
  "icon": "fork-icon",
  "shortcut": "cmd+shift+f",
  "enabled_when": "active_terminal.has_cc_session",
  "tooltip": "Fork this Claude session into a new tab"
}
```

```json
{
  "id": "plugins",
  "label": "/plugins",
  "mode": "inject",
  "implementation": {
    "kind": "stdin_write",
    "payload": "/plugins\n"
  },
  "shortcut": null,
  "enabled_when": "active_terminal.is_running_claude",
  "tooltip": "Open Claude Code plugins list"
}
```

```json
{
  "id": "resume-split",
  "label": "/resume-split",
  "mode": "hybrid",
  "steps": [
    {"kind": "open_picker", "picker": "session"},
    {"kind": "split_tab", "direction": "vertical"},
    {"kind": "spawn_terminal", "command": "claude --resume ${picked_session_id}"}
  ]
}
```

### Key fields

- `id` — internal identifier (stable)
- `label` — what appears in the button (human-readable, usually `/command`-style)
- `mode` — `orchestration` / `inject` / `hybrid`
- `implementation` — structure varies by mode (see schemas)
- `shortcut` — optional keyboard binding
- `enabled_when` — expression that decides if the action appears (context-aware)
- `tooltip` — hover help text

---

## Context-aware enablement

Quick Actions should surface based on what's currently possible:

- `active_terminal.has_cc_session` — true when the focused terminal is running `claude` with an attached session. Gates actions like `/fork`, `/compact`, `/plugins`.
- `active_terminal.is_shell` — true for plain shell terminals. Gates shell-specific actions (future).
- `space.has_dev_server` — true if any terminal in the space is detected as running a dev server. Gates automations like "stop dev server."
- `session.has_fork_history` — true if the session was itself forked (shows `/merge-back` or similar).

Implementation: a small predicate engine evaluates `enabled_when` against Orpheus state on each relevant state change, filters the visible Quick Actions list accordingly.

---

## Discoverability + configuration

**Default visible slots in the Quick Actions strip:** ~4 actions. Too many makes the bar cluttered. The `[ ... ]` "more" button at the end opens a full picker showing all registered actions plus keyboard shortcuts.

**User customization** (post-v0; tracked under `future-scope.md` "Per-space configuration overrides"):
- Add custom actions (any of three modes)
- Reorder the visible slots
- Change keyboard shortcuts
- Disable default actions

**Per-project / per-space overrides** (also future-scope):
- Different project = different set of quick actions (e.g., a Rails project has `/rake` as inject; a JS project has `/npm-test`).
- Per-space overrides stack on top of project overrides.

---

## Relation to self-drive CLI

The `orpheus` CLI binary (architecture.md §6) exposes all orchestration capabilities as JSON-RPC commands. Mode A quick actions dispatch to the same command surface internally. For example:

- Quick Action `/fork` (Mode A) → internally calls the same code path as `orpheus session fork --current`.
- Quick Action `/new-space` → same as `orpheus spaces create`.

This parity keeps "what the user can click" and "what Claude can invoke via self-drive" in sync. Every UI action has a CLI equivalent; every CLI capability surfaces in quick actions (or via command palette). This is the symmetry-of-agency principle from the product scope.

---

## Open questions (for implementation phase)

1. **Session ID capture after spawn.** When `claude --resume <id> --fork-session` spawns, the new session gets a fresh UUID. How does Orpheus reliably capture it? Options:
   - Parse stdout (risky — CC output format could change)
   - Poll `~/.claude/projects/<cwd-encoded>/` for the new JSONL file and correlate by mtime + cwd
   - Use `claude --output-format stream-json --session-id <known-new-uuid>` and pre-generate the UUID ourselves (let Orpheus decide the session ID)
   Third option is cleanest if CC honors a user-supplied session ID on fork.

2. **Partial-input handling on inject.** If user is typing when a Quick Action fires, how to not clobber? Options: queue behind user input, warn user, or block action while input non-empty. Probably queue-and-signal.

3. **Fork + unsaved state.** If Claude is mid-response in the original tab, what happens? The fork starts from the latest SAVED message in JSONL; the in-flight response stays in the original tab and gets written to the original session's log. Fine as long as we fork from JSONL-latest-line, not in-memory-latest.

4. **Multi-tab fork.** Can you fork a tab that's itself a fork? Yes, trivially (any session with a UUID can be resumed + fork). No lineage tracking in v0, but could be added (sessions with `forked_from` pointer) as a future enhancement.

5. **Custom user actions input source.** When a user adds a custom action, where do they write it? JSON file under `.orpheus/config.json`? GUI settings panel? Both? Implementation detail for later.

6. **Action execution failure.** What does the user see if `/fork` fails (CC exited, session JSONL corrupt)? Toast notification + error state in the new tab, probably. Documented in error-state wireframes (future).

7. **Pre-v0 keyboard shortcut conflicts.** Multiple actions may want `Cmd+Shift+F`. Validation at config load; warn user if collision. Ship defaults that don't collide.

---

## Not in scope here

- Visual design of the Quick Actions strip (in `wireframes-v0.5.md` Wireframe 4).
- Specific color / typography / animation (in `docs/specs/design-principles.md`).
- The `[ ... ]` more-actions expanded picker UI (wireframe TBD).
- Voice-invocation of quick actions (voice-loop spec, future).
