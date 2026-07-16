# `src/main/db.ts` surface reference (as of this capture)

This is a **verbatim** capture of the schema constants, indexes, exports, and the
five real data-mutating migrations in `src/main/db.ts` (2409 lines,
`CURRENT_VERSION = 63` at capture time). It exists so a later refactor of the
migration engine can port the schema and data transforms without re-reading the
whole file. Nothing here is paraphrased — SQL blocks are copied character for
character from the source, including whitespace.

Source: `src/main/db.ts`

---

## Exports

Authoritative list via `grep -nE "^export (function|const|type|interface|class)" src/main/db.ts`:

```
12:export const CURRENT_VERSION = 63
391:export function getDb(): Database.Database {
412:export function migrate(db: Database.Database): void {
```

There are exactly **3** exported symbols. Full signatures:

- **`CURRENT_VERSION`** (line 12)
  ```ts
  export const CURRENT_VERSION = 63
  ```

- **`getDb`** (line 391)
  ```ts
  export function getDb(): Database.Database {
  ```
  Full body summary (not exported further, but documented for context): lazily
  constructs/opens the singleton `better-sqlite3` `Database` at
  `app.getPath('userData')/orpheus.sqlite`, sets pragmas (`journal_mode = WAL`,
  `foreign_keys = ON`, `synchronous = NORMAL`, `cache_size = -8000`,
  `mmap_size = 268435456`, `temp_store = MEMORY`), calls `migrate(db)`, caches
  in module-level `_db`, and returns it. Signature is exactly:
  ```ts
  export function getDb(): Database.Database
  ```

- **`migrate`** (line 412)
  ```ts
  export function migrate(db: Database.Database): void {
  ```
  Signature is exactly:
  ```ts
  export function migrate(db: Database.Database): void
  ```

No other `export function|const|type|interface|class` declarations exist in the file (grep count = 3). There are no exported `type`/`interface`/`class` declarations in `db.ts` — all shared types live in `src/shared/types.ts` per project convention.

### Non-exported but structurally important symbols

For completeness (since a refactor needs to know what's private vs. public):

- `SCHEMA_SQL`, `WORKSPACES_SCHEMA_SQL`, `CLAUDE_SETTINGS_SCHEMA_SQL`, `ACTION_AUDIT_LOG_SCHEMA_SQL`, `DIAGNOSTICS_SCHEMA_SQL`, `FOOTER_ACTIONS_SCHEMA_SQL`, `CLAUDE_PROJECT_SETTINGS_SCHEMA_SQL`, `CLAUDE_WORKSPACE_SETTINGS_SCHEMA_SQL`, `UI_STATE_SCHEMA_SQL`, `KEEP_AWAKE_SCHEMA_SQL` — module-private `const` string constants (template literals) holding the fresh-install `CREATE TABLE IF NOT EXISTS` DDL. See **Tables** below.
- `let _db: Database.Database | null = null` (line 389) — singleton cache.
- `function healProjectsArchivedAt(db: Database.Database): void` (line 2320) — private. Re-adds `projects.archived_at` if missing (healed on every boot, before the fast-path return).
- `function healWorkspacesCheck(db: Database.Database): void` (line 2334) — private. Copy-migrates the `workspaces` table if its `CHECK (status IN (...))` constraint is stale (missing a current status value, or still contains a legacy one).

---

## Tables

Each fresh-install `CREATE TABLE IF NOT EXISTS` constant, copied verbatim from its schema-constant string block (not from any later `ALTER TABLE`).

### `schema_version`

Lines 15-17, part of `SCHEMA_SQL` (lines 14-49).

```sql
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  );
```

Columns: 1 (`version`).

### `projects`

Lines 19-27, part of `SCHEMA_SQL`.

```sql
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY NOT NULL,
    path TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    claude_encoded_name TEXT,
    added_at INTEGER NOT NULL,
    last_opened_at INTEGER,
    pinned_at INTEGER
  );
```

Columns in CREATE TABLE constant: 7.

Columns added ONLY via later `ALTER TABLE` (absent from this constant):
- `expanded_in_sidebar INTEGER NOT NULL DEFAULT 0` (added via ALTER at v6, line 514)
- `sort_order INTEGER` (added via ALTER at v19, line 955)
- `github_owner TEXT` (added via ALTER at v37, line 1548)
- `github_repo TEXT` (added via ALTER at v37, line 1553)
- `github_avatar_url TEXT` (added via ALTER at v37, line 1558)
- `github_checked_at INTEGER` (added via ALTER at v37, line 1563)

Notes (not new columns, but material to a refactor):
- `pinned_at` — added via ALTER at v2 (line 456: `ALTER TABLE projects ADD COLUMN pinned_at INTEGER`), then **dropped** at v4 (line 488: `ALTER TABLE projects DROP COLUMN pinned_at`). It is present again in the current `SCHEMA_SQL` constant above (line 26) as of a later schema revision — i.e. the column exists today in the CREATE TABLE constant itself, but its lifecycle historically included an add/drop cycle. v63 (line 2287-2292) also defensively re-adds it (`ALTER TABLE projects ADD COLUMN pinned_at INTEGER`, wrapped in try/catch) plus a new index `projects_pinned_idx` (line 2294) for pre-v63 DBs that still lack it.
- `archived_at` — declared in the CREATE TABLE comment context is **not** present in the current `SCHEMA_SQL` constant (it was dropped at v3, line 469: `ALTER TABLE projects DROP COLUMN archived_at`), but is referenced by `listAllSessions` and the `idx_projects_archived_at` index (v41). `healProjectsArchivedAt()` (line 2320) defensively re-adds it on every boot if missing (`ALTER TABLE projects ADD COLUMN archived_at INTEGER`), since a DB that migrated through v3 loses the column and never re-runs migrations once at `CURRENT_VERSION` (fast-path return). This is a "healing" ALTER, not a version-gated one — it runs unconditionally at the top of `migrate()`.

### `sessions`

Lines 29-42, part of `SCHEMA_SQL`.

```sql
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    jsonl_path TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'in_review'
      CHECK (status IN ('in_progress', 'in_review', 'archived')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    model TEXT,
    last_message_role TEXT,
    jsonl_mtime INTEGER
  );
```

Columns in CREATE TABLE constant: 11.

Columns added ONLY via later `ALTER TABLE` (absent from this constant... note: `jsonl_mtime` IS present in the constant above already, so it is NOT alter-only despite being added at v50 historically — the schema constant was updated to include it for fresh installs, and v50's ALTER (line 2075: `ALTER TABLE sessions ADD COLUMN jsonl_mtime INTEGER`) is the defensive no-op path for pre-v50 DBs):
- `message_count INTEGER` (added via ALTER at v33, line 1482)
- `jsonl_size_bytes INTEGER` (added via ALTER at v33, line 1487)
- `last_message_preview TEXT` (added via ALTER at v34, line 1502)
- `last_user_message_preview TEXT` (added via ALTER at v35, line 1512)

### `workspaces`

Lines 57-73, the `WORKSPACES_SCHEMA_SQL` constant (lines 56-78). Preceded by this comment in-source (kept for context, not part of the SQL):

```
// CHECK kept in sync with WorkspaceStatus (shared/types.ts). When this drifted
// historically (v21 enum survived past v28's value migration), every dispatch to
// 'awaiting_input'|'attention'|'idle' raised CHECK constraint failed and got
// swallowed in setWorkspaceStatus's catch — leaving rows frozen at 'in_progress'
// and surfacing as a stuck "Claude is thinking" indicator across restarts.
```

```sql
  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    pinned_at INTEGER,
    created_at INTEGER NOT NULL,
    last_opened_at INTEGER,
    archived_at INTEGER,
    closed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN ('in_progress', 'awaiting_input', 'attention', 'idle', 'archived')),
    name_is_auto INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER,
    claude_session_id TEXT,
    last_title TEXT
  );
  CREATE INDEX IF NOT EXISTS workspaces_project_id_idx ON workspaces(project_id);
  CREATE INDEX IF NOT EXISTS workspaces_pinned_idx ON workspaces(pinned_at);
  CREATE INDEX IF NOT EXISTS idx_workspaces_project_sort
    ON workspaces(project_id, sort_order, created_at DESC);
```

Columns in CREATE TABLE constant: 14. (`name_is_auto`, `sort_order`, `claude_session_id`, `last_title`, `closed_at` are all now baked into the fresh-install constant even though they were historically added via ALTER at v3/v20/v26/v27/v57 respectively — the constant was kept up to date, so none of these are "ALTER-only".)

Columns added ONLY via later `ALTER TABLE` (absent from this constant):
- `forked_from_session_id TEXT` (added via ALTER at v43, line 1685)

Note: `status`'s CHECK clause has drifted over the migration history (see `healWorkspacesCheck`, line 2334) — the v21 ALTER (line 976) used a *different*, now-stale CHECK (`'in_progress', 'in_review', 'completed', 'archived'`) which is healed unconditionally on every `migrate()` call (not version-gated) if detected stale. The CREATE TABLE constant above is the canonical/current CHECK.

### `claude_global_settings`

Lines 81-209, the `CLAUDE_SETTINGS_SCHEMA_SQL` constant (lines 80-210).

```sql
  CREATE TABLE IF NOT EXISTS claude_global_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    model TEXT NOT NULL DEFAULT 'sonnet',
    permission_mode TEXT NOT NULL DEFAULT 'default'
      CHECK (permission_mode IN ('default', 'acceptEdits', 'plan', 'bypassPermissions')),
    effort TEXT NOT NULL DEFAULT 'auto'
      CHECK (effort IN ('auto', 'low', 'medium', 'high', 'xhigh', 'max')),
    auto_memory INTEGER NOT NULL DEFAULT 1 CHECK (auto_memory IN (0, 1)),
    always_thinking INTEGER NOT NULL DEFAULT 0 CHECK (always_thinking IN (0, 1)),
    output_style TEXT NOT NULL DEFAULT 'default'
      CHECK (output_style IN ('default', 'explanatory', 'proactive', 'learning')),
    tui_mode TEXT NOT NULL DEFAULT 'default'
      CHECK (tui_mode IN ('default', 'fullscreen')),
    editor_mode TEXT NOT NULL DEFAULT 'normal'
      CHECK (editor_mode IN ('normal', 'vim')),
    reduce_motion INTEGER NOT NULL DEFAULT 0 CHECK (reduce_motion IN (0, 1)),
    native_cursor INTEGER NOT NULL DEFAULT 0 CHECK (native_cursor IN (0, 1)),
    hide_cwd INTEGER NOT NULL DEFAULT 0 CHECK (hide_cwd IN (0, 1)),
    -- Memory section (v9)
    disable_git_instructions INTEGER NOT NULL DEFAULT 0 CHECK (disable_git_instructions IN (0, 1)),
    max_output_tokens INTEGER,
    max_context_tokens INTEGER,
    compaction_threshold INTEGER,
    -- Developer section (v9)
    debug_logging INTEGER NOT NULL DEFAULT 0 CHECK (debug_logging IN (0, 1)),
    log_level TEXT NOT NULL DEFAULT 'info' CHECK (log_level IN ('debug', 'info', 'warn', 'error')),
    disable_telemetry INTEGER NOT NULL DEFAULT 0 CHECK (disable_telemetry IN (0, 1)),
    disable_error_reporting INTEGER NOT NULL DEFAULT 0 CHECK (disable_error_reporting IN (0, 1)),
    disable_autoupdater INTEGER NOT NULL DEFAULT 0 CHECK (disable_autoupdater IN (0, 1)),
    experimental_agent_teams INTEGER NOT NULL DEFAULT 0 CHECK (experimental_agent_teams IN (0, 1)),
    experimental_forked_subagents INTEGER NOT NULL DEFAULT 0 CHECK (experimental_forked_subagents IN (0, 1)),
    simple_system_prompt INTEGER NOT NULL DEFAULT 0 CHECK (simple_system_prompt IN (0, 1)),
    -- Permissions section (v9)
    auto_approve_edits INTEGER NOT NULL DEFAULT 0 CHECK (auto_approve_edits IN (0, 1)),
    ask_destructive_bash INTEGER NOT NULL DEFAULT 0 CHECK (ask_destructive_bash IN (0, 1)),
    plan_mode_default INTEGER NOT NULL DEFAULT 0 CHECK (plan_mode_default IN (0, 1)),
    permission_allow_rules TEXT NOT NULL DEFAULT '[]',
    permission_ask_rules TEXT NOT NULL DEFAULT '[]',
    permission_deny_rules TEXT NOT NULL DEFAULT '[]',
    permission_additional_dirs TEXT NOT NULL DEFAULT '[]',
    -- Fallback model (v11)
    fallback_model TEXT NOT NULL DEFAULT '',
    -- Auth (v13 / v16 / v17)
    cloud_provider TEXT NOT NULL DEFAULT 'anthropic'
      CHECK (cloud_provider IN ('anthropic', 'bedrock', 'vertex', 'foundry')),
    auth_encrypted_blob BLOB,
    auth_api_key TEXT NOT NULL DEFAULT '',
    auth_token TEXT NOT NULL DEFAULT '',
    auth_base_url TEXT NOT NULL DEFAULT '',
    auth_aws_region TEXT NOT NULL DEFAULT '',
    auth_vertex_project_id TEXT NOT NULL DEFAULT '',
    auth_vertex_region TEXT NOT NULL DEFAULT '',
    -- Tools section (v14)
    bash_default_timeout_ms INTEGER,
    bash_max_timeout_ms INTEGER,
    bash_max_output_length INTEGER,
    tool_concurrency INTEGER,
    browser_integration INTEGER NOT NULL DEFAULT 1 CHECK (browser_integration IN (0, 1)),
    disabled_mcp_servers TEXT NOT NULL DEFAULT '[]',
    -- Foundry + Bedrock bearer token + custom env vars (v22)
    auth_foundry_api_key TEXT NOT NULL DEFAULT '',
    auth_foundry_resource TEXT NOT NULL DEFAULT '',
    auth_foundry_base_url TEXT NOT NULL DEFAULT '',
    auth_bedrock_bearer_token TEXT NOT NULL DEFAULT '',
    custom_env_vars TEXT NOT NULL DEFAULT '{}',
    -- Env-var controls (v23)
    disable_thinking INTEGER NOT NULL DEFAULT 0 CHECK (disable_thinking IN (0, 1)),
    disable_fast_mode INTEGER NOT NULL DEFAULT 0 CHECK (disable_fast_mode IN (0, 1)),
    max_turns INTEGER,
    max_thinking_tokens INTEGER,
    file_read_max_output_tokens INTEGER,
    disable_claude_mds INTEGER NOT NULL DEFAULT 0 CHECK (disable_claude_mds IN (0, 1)),
    bash_maintain_cwd INTEGER NOT NULL DEFAULT 0 CHECK (bash_maintain_cwd IN (0, 1)),
    perforce_mode INTEGER NOT NULL DEFAULT 0 CHECK (perforce_mode IN (0, 1)),
    glob_hidden INTEGER NOT NULL DEFAULT 0 CHECK (glob_hidden IN (0, 1)),
    glob_no_ignore INTEGER NOT NULL DEFAULT 0 CHECK (glob_no_ignore IN (0, 1)),
    glob_timeout_seconds INTEGER,
    api_timeout_ms INTEGER,
    max_retries INTEGER,
    http_proxy TEXT NOT NULL DEFAULT '',
    https_proxy TEXT NOT NULL DEFAULT '',
    disable_nonessential_traffic INTEGER NOT NULL DEFAULT 0 CHECK (disable_nonessential_traffic IN (0, 1)),
    do_not_track INTEGER NOT NULL DEFAULT 0 CHECK (do_not_track IN (0, 1)),
    disable_background_tasks INTEGER NOT NULL DEFAULT 0 CHECK (disable_background_tasks IN (0, 1)),
    disable_agent_view INTEGER NOT NULL DEFAULT 0 CHECK (disable_agent_view IN (0, 1)),
    anthropic_betas TEXT NOT NULL DEFAULT '',
    extra_body_json TEXT NOT NULL DEFAULT '',
    -- More env-var controls (v24)
    no_flicker INTEGER NOT NULL DEFAULT 0 CHECK (no_flicker IN (0, 1)),
    disable_alternate_screen INTEGER NOT NULL DEFAULT 0 CHECK (disable_alternate_screen IN (0, 1)),
    disable_virtual_scroll INTEGER NOT NULL DEFAULT 0 CHECK (disable_virtual_scroll IN (0, 1)),
    disable_mouse INTEGER NOT NULL DEFAULT 0 CHECK (disable_mouse IN (0, 1)),
    disable_terminal_title INTEGER NOT NULL DEFAULT 0 CHECK (disable_terminal_title IN (0, 1)),
    scroll_speed INTEGER,
    code_accessibility INTEGER NOT NULL DEFAULT 0 CHECK (code_accessibility IN (0, 1)),
    omit_attribution_header INTEGER NOT NULL DEFAULT 0 CHECK (omit_attribution_header IN (0, 1)),
    force_sync_output INTEGER NOT NULL DEFAULT 0 CHECK (force_sync_output IN (0, 1)),
    enable_prompt_suggestion INTEGER NOT NULL DEFAULT 0 CHECK (enable_prompt_suggestion IN (0, 1)),
    disable_1m_context INTEGER NOT NULL DEFAULT 0 CHECK (disable_1m_context IN (0, 1)),
    disable_adaptive_thinking INTEGER NOT NULL DEFAULT 0 CHECK (disable_adaptive_thinking IN (0, 1)),
    disable_legacy_model_remap INTEGER NOT NULL DEFAULT 0 CHECK (disable_legacy_model_remap IN (0, 1)),
    auto_compact_window INTEGER,
    autocompact_pct_override INTEGER,
    disable_file_checkpointing INTEGER NOT NULL DEFAULT 0 CHECK (disable_file_checkpointing IN (0, 1)),
    disable_attachments INTEGER NOT NULL DEFAULT 0 CHECK (disable_attachments IN (0, 1)),
    shell_override TEXT NOT NULL DEFAULT '',
    shell_prefix TEXT NOT NULL DEFAULT '',
    enable_fine_grained_tool_streaming INTEGER NOT NULL DEFAULT 0 CHECK (enable_fine_grained_tool_streaming IN (0, 1)),
    disable_nonstreaming_fallback INTEGER NOT NULL DEFAULT 0 CHECK (disable_nonstreaming_fallback IN (0, 1)),
    proxy_resolves_hosts INTEGER NOT NULL DEFAULT 0 CHECK (proxy_resolves_hosts IN (0, 1)),
    enable_gateway_model_discovery INTEGER NOT NULL DEFAULT 0 CHECK (enable_gateway_model_discovery IN (0, 1)),
    auto_background_tasks INTEGER NOT NULL DEFAULT 0 CHECK (auto_background_tasks IN (0, 1)),
    async_agent_stall_timeout_ms INTEGER,
    enable_tasks INTEGER NOT NULL DEFAULT 0 CHECK (enable_tasks IN (0, 1)),
    disable_cron INTEGER NOT NULL DEFAULT 0 CHECK (disable_cron IN (0, 1)),
    exit_after_stop_delay INTEGER,
    disable_feedback_command INTEGER NOT NULL DEFAULT 0 CHECK (disable_feedback_command IN (0, 1)),
    disable_feedback_survey INTEGER NOT NULL DEFAULT 0 CHECK (disable_feedback_survey IN (0, 1)),
    -- Env-var controls (v52) — new feature toggles
    disable_bundled_skills INTEGER NOT NULL DEFAULT 0 CHECK (disable_bundled_skills IN (0, 1)),
    disable_workflows INTEGER NOT NULL DEFAULT 0 CHECK (disable_workflows IN (0, 1)),
    enable_away_summary INTEGER NOT NULL DEFAULT 0 CHECK (enable_away_summary IN (0, 1)),
    disable_artifact INTEGER NOT NULL DEFAULT 0 CHECK (disable_artifact IN (0, 1)),
    disable_advisor_tool INTEGER NOT NULL DEFAULT 0 CHECK (disable_advisor_tool IN (0, 1)),
    screen_reader INTEGER NOT NULL DEFAULT 0 CHECK (screen_reader IN (0, 1)),
    additional_dirs_claude_md INTEGER NOT NULL DEFAULT 0 CHECK (additional_dirs_claude_md IN (0, 1)),
    ghostty_config_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
```

**Column count: 110** (counted as column-definition lines in the CREATE body; task brief estimated "roughly 150" — actual is 110, flagged as a discrepancy vs. the brief's estimate, not vs. any version-origin claim. The transcribed column set above is byte-for-byte identical to the source `CREATE TABLE` constant.).

No columns for this table are ALTER-only (absent from the constant) — every column added across v8/v9/v11/v13/v14/v16/v17/v22/v23/v24/v52/v53 migrations has been folded back into this fresh-install constant, per the file's stated convention ("Pattern for additive changes is non-destructive: add the column to the CREATE TABLE block for fresh installs, then append a defensive ALTER").

### `claude_project_settings`

Lines 310-314, the `CLAUDE_PROJECT_SETTINGS_SCHEMA_SQL` constant (lines 309-315).

```sql
  CREATE TABLE IF NOT EXISTS claude_project_settings (
    project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    overrides_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
```

Columns: 3. No ALTER-only additions found for this table.

### `claude_workspace_settings`

Lines 318-322, the `CLAUDE_WORKSPACE_SETTINGS_SCHEMA_SQL` constant (lines 317-323).

```sql
  CREATE TABLE IF NOT EXISTS claude_workspace_settings (
    workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    overrides_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
```

Columns: 3. No ALTER-only additions found for this table.

### `app_ui_state`

Lines 326-371, the `UI_STATE_SCHEMA_SQL` constant (lines 325-372).

```sql
  CREATE TABLE IF NOT EXISTS app_ui_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sidebar_collapsed INTEGER NOT NULL DEFAULT 0 CHECK (sidebar_collapsed IN (0, 1)),
    last_view_kind TEXT NOT NULL DEFAULT 'dashboard'
      CHECK (last_view_kind IN ('dashboard', 'sessions', 'project', 'workspace')),
    last_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    last_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    window_x INTEGER,
    window_y INTEGER,
    window_width INTEGER,
    window_height INTEGER,
    window_fullscreen INTEGER NOT NULL DEFAULT 0 CHECK (window_fullscreen IN (0, 1)),
    -- Window behavior preferences (v11)
    restore_geometry INTEGER NOT NULL DEFAULT 1 CHECK (restore_geometry IN (0, 1)),
    close_hides INTEGER NOT NULL DEFAULT 1 CHECK (close_hides IN (0, 1)),
    open_at_last_view INTEGER NOT NULL DEFAULT 1 CHECK (open_at_last_view IN (0, 1)),
    -- Sidebar behavior preferences (v12)
    pinned_section_visible INTEGER NOT NULL DEFAULT 1 CHECK (pinned_section_visible IN (0, 1)),
    workspace_count_inline INTEGER NOT NULL DEFAULT 1 CHECK (workspace_count_inline IN (0, 1)),
    sidebar_width INTEGER NOT NULL DEFAULT 256 CHECK (sidebar_width BETWEEN 200 AND 480),
    default_project_expanded INTEGER NOT NULL DEFAULT 0 CHECK (default_project_expanded IN (0, 1)),
    -- Launch + hotkey (v18)
    launch_at_login INTEGER NOT NULL DEFAULT 0 CHECK (launch_at_login IN (0, 1)),
    global_hotkey TEXT NOT NULL DEFAULT '',
    -- Archive cap (v25)
    archived_workspace_limit INTEGER NOT NULL DEFAULT 20,
    -- Status polling preferences (v42)
    status_poll_interval_sec INTEGER NOT NULL DEFAULT 1800,
    mute_status_notifications INTEGER NOT NULL DEFAULT 0 CHECK (mute_status_notifications IN (0, 1)),
    -- Workspace footer visibility (v45)
    show_workspace_footer INTEGER NOT NULL DEFAULT 1 CHECK (show_workspace_footer IN (0, 1)),
    -- Diagnostics capture toggles (v56)
    diag_error INTEGER NOT NULL DEFAULT 1,
    diag_lifecycle INTEGER NOT NULL DEFAULT 0,
    diag_perf INTEGER NOT NULL DEFAULT 0,
    diag_anomaly INTEGER NOT NULL DEFAULT 0,
    -- Trace capture (v61) — off by default
    diag_trace INTEGER NOT NULL DEFAULT 0,
    auto_close_after_minutes INTEGER,
    -- Notification enrichment (v59)
    notify_rich_summary BOOLEAN NOT NULL DEFAULT 1,
    notify_suppress_when_focused BOOLEAN NOT NULL DEFAULT 0,
    -- Hooks integration (v60) — default 0 (off); opt-in to socket server + settings.json hooks
    hooks_integration_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
```

**Column count: 33** (top-level comma boundaries).

Columns added ONLY via later `ALTER TABLE` (absent from this constant — this table has the most drift between the fresh-install constant and actual runtime schema of any table in the file):
- `notify_attention BOOLEAN NOT NULL DEFAULT 1` (added via ALTER at v29, line 1425)
- `notify_stop BOOLEAN NOT NULL DEFAULT 1` (added via ALTER at v29, line 1430)
- `notify_always BOOLEAN NOT NULL DEFAULT 0` (added via ALTER at v29, line 1435)
- `notify_max_attention_repeats INTEGER NOT NULL DEFAULT 5` (added via ALTER at v30, line 1445)
- `in_progress_watchdog_sec INTEGER NOT NULL DEFAULT 120` (added via ALTER at v31, line 1456)
- `preferred_editor_app TEXT` (added via ALTER at v32, line 1467)
- `preferred_terminal_app TEXT` (added via ALTER at v32, line 1472)
- `max_local_sessions INTEGER` (added via ALTER at v33, line 1492)
- `theme TEXT NOT NULL DEFAULT 'midnight' CHECK (theme IN ('midnight', 'daylight', 'eclipse'))` (added via ALTER at v36, line 1523)
- `accent_color TEXT CHECK (accent_color IS NULL OR accent_color IN ('gold', 'blue', 'teal', 'orange', 'pink'))` (added via ALTER at v36, line 1530)
- `ui_font_scale TEXT NOT NULL DEFAULT 'default' CHECK (ui_font_scale IN ('small', 'default', 'large'))` (added via ALTER at v36, line 1537)
- `fetch_github_avatars INTEGER NOT NULL DEFAULT 1 CHECK (fetch_github_avatars IN (0, 1))` (added via ALTER at v37, line 1570)
- `play_interaction_sounds INTEGER NOT NULL DEFAULT 1 CHECK (play_interaction_sounds IN (0, 1))` (added via ALTER at v38, line 1582)
- `sound_pack TEXT NOT NULL DEFAULT 'core' CHECK (sound_pack IN ('core', 'minimal', 'mechanical', 'retro', 'playful', 'crisp', 'organic', 'soft'))` (added via ALTER at v39, line 1594)
- `auto_check_updates INTEGER NOT NULL DEFAULT 1 CHECK (auto_check_updates IN (0, 1))` (added via ALTER at v40, line 1606)
- `stale_after_minutes INTEGER NOT NULL DEFAULT 60` (added via ALTER at v54, line 2167)

Note: several columns that DO appear in the constant above with a version comment (e.g. `restore_geometry`/`close_hides`/`open_at_last_view` "(v11)", `archived_workspace_limit` "(v25)", `status_poll_interval_sec`/`mute_status_notifications` "(v42)", `show_workspace_footer` "(v45)", `diag_error`/`diag_lifecycle`/`diag_perf`/`diag_anomaly` "(v56)", `diag_trace` "(v61)", `auto_close_after_minutes` (v57, no inline comment but added there), `notify_rich_summary`/`notify_suppress_when_focused` "(v59)", `hooks_integration_enabled` "(v60)") were **also folded into the constant**, so they are NOT ALTER-only despite having a version-gated ALTER as their defensive-idempotent counterpart for pre-vN installs.

### `action_audit_log`

Lines 215-223, the `ACTION_AUDIT_LOG_SCHEMA_SQL` constant (lines 214-226).

```sql
  CREATE TABLE IF NOT EXISTS action_audit_log (
    id INTEGER PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    params_json TEXT NOT NULL,
    result_code TEXT NOT NULL,
    consumer_hint TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_action_audit_workspace_created
    ON action_audit_log(workspace_id, created_at DESC);
```

Columns: 7. No ALTER-only additions found (table itself introduced at v43, but always via this full `CREATE TABLE IF NOT EXISTS` — no partial-column ALTER path).

### `diagnostics_events`

Lines 232-250, the `DIAGNOSTICS_SCHEMA_SQL` constant (lines 231-255).

```sql
  CREATE TABLE IF NOT EXISTS diagnostics_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    process      TEXT NOT NULL,
    category     TEXT NOT NULL,
    level        TEXT NOT NULL,
    event        TEXT NOT NULL,
    workspace_id TEXT,
    session_id   TEXT,
    duration_ms  INTEGER,
    message      TEXT,
    data         TEXT,
    seq          INTEGER NOT NULL,
    trace_id        TEXT,
    span_id         TEXT,
    parent_span_id  TEXT,
    name            TEXT,
    kind            TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_diag_ts       ON diagnostics_events(ts);
  CREATE INDEX IF NOT EXISTS idx_diag_cat_ts   ON diagnostics_events(category, ts);
  CREATE INDEX IF NOT EXISTS idx_diag_ws_ts    ON diagnostics_events(workspace_id, ts);
  CREATE INDEX IF NOT EXISTS idx_diag_event_ts ON diagnostics_events(event, ts);
```

Columns: 17 (`trace_id`/`span_id`/`parent_span_id`/`name`/`kind` are baked into this constant even though they were also added defensively via ALTER at v61 for pre-v61/v55 installs — see line 2252-2264 which loops `['trace_id TEXT', 'span_id TEXT', 'parent_span_id TEXT', 'name TEXT', 'kind TEXT']`). Not ALTER-only since present in the constant.

The table itself is created unconditionally at every `migrate()` call via `db.exec(DIAGNOSTICS_SCHEMA_SQL)` (line 442), and again defensively at v55 (line 2176: `db.exec(DIAGNOSTICS_SCHEMA_SQL)`).

### `footer_actions_global`

Lines 261-272, part of `FOOTER_ACTIONS_SCHEMA_SQL` (lines 260-307).

```sql
  CREATE TABLE IF NOT EXISTS footer_actions_global (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    icon TEXT,
    action_id TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    visible_when TEXT NOT NULL DEFAULT 'always',
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    prompts_json TEXT
  );
```

Columns: 10. `prompts_json` is baked into the constant (also defensively ALTERed at v49, line 1974 — `ALTER TABLE footer_actions_global ADD COLUMN prompts_json TEXT` — for pre-v49 DBs). Not ALTER-only.

### `footer_actions_project`

Lines 274-287, part of `FOOTER_ACTIONS_SCHEMA_SQL`.

```sql
  CREATE TABLE IF NOT EXISTS footer_actions_project (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    label TEXT NOT NULL,
    icon TEXT,
    action_id TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    visible_when TEXT NOT NULL DEFAULT 'always',
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    prompts_json TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_footer_actions_project_project_id
    ON footer_actions_project(project_id);
```

Columns: 11 (+ 1 table-level `FOREIGN KEY` constraint, not a column). `prompts_json` also defensively ALTERed at v49 (line 1979). Not ALTER-only.

### `footer_actions_workspace`

Lines 291-304, part of `FOOTER_ACTIONS_SCHEMA_SQL`.

```sql
  CREATE TABLE IF NOT EXISTS footer_actions_workspace (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    label TEXT NOT NULL,
    icon TEXT,
    action_id TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    visible_when TEXT NOT NULL DEFAULT 'always',
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    prompts_json TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_footer_actions_workspace_workspace_id
    ON footer_actions_workspace(workspace_id);
```

Columns: 11 (+ 1 table-level `FOREIGN KEY` constraint). `prompts_json` also defensively ALTERed at v49 (line 1984). Not ALTER-only.

### `keep_awake_settings`

Lines 375-380, the `KEEP_AWAKE_SCHEMA_SQL` constant (lines 374-383).

```sql
  CREATE TABLE IF NOT EXISTS keep_awake_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('off', 'auto', 'on')),
    display_on INTEGER NOT NULL DEFAULT 0 CHECK (display_on IN (0, 1)),
    timer_minutes INTEGER NOT NULL DEFAULT 120
  );
  INSERT OR IGNORE INTO keep_awake_settings (id, mode, display_on, timer_minutes)
    VALUES (1, 'auto', 0, 120);
```

Columns: 4. This table (and its seed `INSERT OR IGNORE`) is introduced at v62 (line 2280: `db.exec(KEEP_AWAKE_SCHEMA_SQL)`, defensive try/catch). No ALTER-only additions.

---

## Indexes

Authoritative list via `grep -nE "CREATE (UNIQUE )?INDEX" src/main/db.ts`. There are **no** `CREATE UNIQUE INDEX` statements in the file — every index is a plain `CREATE INDEX IF NOT EXISTS`. Listed in file order, verbatim:

```sql
-- line 44 (SCHEMA_SQL, sessions)
CREATE INDEX IF NOT EXISTS sessions_project_id_idx ON sessions(project_id);
```

```sql
-- line 45 (SCHEMA_SQL, sessions)
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);
```

```sql
-- line 46 (SCHEMA_SQL, sessions)
CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions(updated_at);
```

```sql
-- lines 47-48 (SCHEMA_SQL, sessions) — partial index
CREATE INDEX IF NOT EXISTS idx_sessions_project_active
    ON sessions(project_id, updated_at ASC) WHERE status != 'archived';
```

```sql
-- line 74 (WORKSPACES_SCHEMA_SQL, workspaces)
CREATE INDEX IF NOT EXISTS workspaces_project_id_idx ON workspaces(project_id);
```

```sql
-- line 75 (WORKSPACES_SCHEMA_SQL, workspaces)
CREATE INDEX IF NOT EXISTS workspaces_pinned_idx ON workspaces(pinned_at);
```

```sql
-- lines 76-77 (WORKSPACES_SCHEMA_SQL, workspaces)
CREATE INDEX IF NOT EXISTS idx_workspaces_project_sort
    ON workspaces(project_id, sort_order, created_at DESC);
```

```sql
-- lines 224-225 (ACTION_AUDIT_LOG_SCHEMA_SQL, action_audit_log)
CREATE INDEX IF NOT EXISTS idx_action_audit_workspace_created
    ON action_audit_log(workspace_id, created_at DESC);
```

```sql
-- line 251 (DIAGNOSTICS_SCHEMA_SQL, diagnostics_events)
CREATE INDEX IF NOT EXISTS idx_diag_ts       ON diagnostics_events(ts);
```

```sql
-- line 252 (DIAGNOSTICS_SCHEMA_SQL, diagnostics_events)
CREATE INDEX IF NOT EXISTS idx_diag_cat_ts   ON diagnostics_events(category, ts);
```

```sql
-- line 253 (DIAGNOSTICS_SCHEMA_SQL, diagnostics_events)
CREATE INDEX IF NOT EXISTS idx_diag_ws_ts    ON diagnostics_events(workspace_id, ts);
```

```sql
-- line 254 (DIAGNOSTICS_SCHEMA_SQL, diagnostics_events)
CREATE INDEX IF NOT EXISTS idx_diag_event_ts ON diagnostics_events(event, ts);
```

```sql
-- lines 288-289 (FOOTER_ACTIONS_SCHEMA_SQL, footer_actions_project)
CREATE INDEX IF NOT EXISTS idx_footer_actions_project_project_id
    ON footer_actions_project(project_id);
```

```sql
-- lines 305-306 (FOOTER_ACTIONS_SCHEMA_SQL, footer_actions_workspace)
CREATE INDEX IF NOT EXISTS idx_footer_actions_workspace_workspace_id
    ON footer_actions_workspace(workspace_id);
```

```sql
-- line 1619 (v41 migration block — same index as WORKSPACES_SCHEMA_SQL above, defensive re-run)
'CREATE INDEX IF NOT EXISTS idx_workspaces_project_sort ON workspaces(project_id, sort_order, created_at DESC)'
```

```sql
-- line 1626 (v41 migration block)
CREATE INDEX IF NOT EXISTS idx_projects_archived_at ON projects(archived_at)
```

```sql
-- lines 1632-1634 (v41 migration block)
'CREATE INDEX IF NOT EXISTS idx_sessions_project_title_lower ON sessions(project_id, LOWER(title))'
```

```sql
-- lines 1640-1642 (v41 migration block)
'CREATE INDEX IF NOT EXISTS idx_sessions_project_updated ON sessions(project_id, updated_at ASC)'
```

```sql
-- lines 1733-1735 (v44 migration block — defensive re-run of FOOTER_ACTIONS_SCHEMA_SQL's index)
'CREATE INDEX IF NOT EXISTS idx_footer_actions_project_project_id ON footer_actions_project(project_id)'
```

```sql
-- lines 1755-1757 (v44 migration block — defensive re-run)
'CREATE INDEX IF NOT EXISTS idx_footer_actions_workspace_workspace_id ON footer_actions_workspace(workspace_id)'
```

```sql
-- lines 2087-2088 (v51 migration block — same as SCHEMA_SQL's idx_sessions_project_active, defensive re-run)
`CREATE INDEX IF NOT EXISTS idx_sessions_project_active
         ON sessions(project_id, updated_at ASC) WHERE status != 'archived'`
```

```sql
-- line 2266 (v61 migration block)
CREATE INDEX IF NOT EXISTS idx_diag_trace ON diagnostics_events(trace_id, ts)
```

```sql
-- line 2294 (v63 migration block)
CREATE INDEX IF NOT EXISTS projects_pinned_idx ON projects(pinned_at)
```

```sql
-- line 2399 (healWorkspacesCheck rebuild path, not a version-gated migration)
CREATE INDEX IF NOT EXISTS workspaces_project_id_idx ON workspaces(project_id)
```

```sql
-- line 2400 (healWorkspacesCheck rebuild path)
CREATE INDEX IF NOT EXISTS workspaces_pinned_idx ON workspaces(pinned_at)
```

```sql
-- lines 2401-2403 (healWorkspacesCheck rebuild path)
'CREATE INDEX IF NOT EXISTS idx_workspaces_project_sort ON workspaces(project_id, sort_order, created_at DESC)'
```

---

## DataTransforms

### 1. v16 — clear the encrypted auth blob

**Expected line ~905, expected version v16.**

Found at line 905, inside `if (currentVersion < 16) { ... }` (block spans lines 886-907).

```ts
  // Version 16: plaintext auth columns replace safeStorage-encrypted blob
  if (currentVersion < 16) {
    try {
      db.exec("ALTER TABLE claude_global_settings ADD COLUMN auth_api_key TEXT NOT NULL DEFAULT ''")
    } catch {
      /* ignore */
    }
    try {
      db.exec("ALTER TABLE claude_global_settings ADD COLUMN auth_token TEXT NOT NULL DEFAULT ''")
    } catch {
      /* ignore */
    }
    try {
      db.exec(
        "ALTER TABLE claude_global_settings ADD COLUMN auth_base_url TEXT NOT NULL DEFAULT ''"
      )
    } catch {
      /* ignore */
    }
    // Clear the old encrypted blob — we can't decrypt it without the original signing identity
    db.prepare('UPDATE claude_global_settings SET auth_encrypted_blob = NULL WHERE id = 1').run()
    db.prepare('UPDATE schema_version SET version = ?').run(16)
  }
```

**Confirmed origin version: v16.** Matches expected exactly — no discrepancy.

### 2. v21 — backfill archived workspace status

**Expected line ~983, expected version v21.**

Found at lines 982-984, inside `if (currentVersion < 21) { ... }` (block spans lines 973-986).

```ts
  // Version 21: workspaces.status — four-stage workflow status
  if (currentVersion < 21) {
    try {
      db.exec(
        "ALTER TABLE workspaces ADD COLUMN status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'in_review', 'completed', 'archived'))"
      )
    } catch {
      /* ignore */
    }
    // Backfill: archived workspaces should have status='archived'
    db.prepare(
      "UPDATE workspaces SET status = 'archived' WHERE archived_at IS NOT NULL AND status != 'archived'"
    ).run()
    db.prepare('UPDATE schema_version SET version = ?').run(21)
  }
```

**Confirmed origin version: v21.** Matches expected exactly — no discrepancy.

### 3. v28 — remap `in_review`/`completed` → `awaiting_input`

**Expected line ~1418, expected version v28.**

Found at lines 1417-1419 (statement executes at line 1417-1419), inside `if (currentVersion < 28) { ... }` (block spans lines 1416-1421).

```ts
  if (currentVersion < 28) {
    db.prepare(
      "UPDATE workspaces SET status = 'awaiting_input' WHERE status IN ('in_review', 'completed')"
    ).run()
    db.prepare('UPDATE schema_version SET version = ?').run(28)
  }
```

**Confirmed origin version: v28.** Matches expected exactly — no discrepancy. (Note: unlike most other blocks, this one has no comment header immediately above it in-source.)

### 4. v45 — Lucide → Phosphor icon rename

**Expected line ~1779, expected version v45.**

Found at line 1779 (`ICON_MIGRATIONS` array), inside `if (currentVersion < 45) { ... }` (block spans lines 1769-1803).

```ts
  // Version 45: workspace footer toggle + phosphor icon migration for footer actions.
  // (a) Adds show_workspace_footer column to app_ui_state (default 1 = visible).
  // (b) Migrates the 6 seeded lucide icon names to their phosphor PascalCase equivalents.
  //     Matches on both icon AND label to avoid touching user-customised rows.
  if (currentVersion < 45) {
    try {
      db.exec(
        'ALTER TABLE app_ui_state ADD COLUMN show_workspace_footer INTEGER NOT NULL DEFAULT 1 CHECK (show_workspace_footer IN (0, 1))'
      )
    } catch {
      /* column may already exist on a fresh install that ran the updated schema */
    }

    // Lucide → Phosphor icon name migration for the 6 default seeds
    const ICON_MIGRATIONS: Array<[string, string, string]> = [
      // [oldIcon, newIcon, label]
      ['git-fork', 'GitFork', 'Fork'],
      ['clipboard', 'Clipboard', '/copy'],
      ['brain', 'Brain', '/context'],
      ['eraser', 'Eraser', '/clear'],
      ['gauge', 'Gauge', 'Context'],
      ['activity', 'Pulse', 'Status']
    ]
    const updateIcon = db.prepare(
      'UPDATE footer_actions_global SET icon = ? WHERE icon = ? AND label = ?'
    )
    const migrateIconsTx = db.transaction(() => {
      for (const [oldIcon, newIcon, label] of ICON_MIGRATIONS) {
        updateIcon.run(newIcon, oldIcon, label)
      }
    })
    try {
      migrateIconsTx()
    } catch {
      /* footer_actions_global may not exist yet on a clean install; safe to skip */
    }

    db.prepare('UPDATE schema_version SET version = ?').run(45)
  }
```

**Confirmed origin version: v45.** Matches expected exactly — no discrepancy.

### 5. v46-v49 — footer seed reconciliation

**Expected line ~1418 area context reused; expected version span v46-v49 across multiple blocks.**

This transform is actually four separate version-gated blocks, confirmed as follows:

#### v46 (block spans lines 1805-1858)

```ts
  // Version 46: footer action seed fixes.
  // (a) Migrate the three slash-command chips from '\r'-embedded text to the
  //     new { text, submit: true } params shape so Enter is sent as a real key
  //     event (kVK_Return) rather than a raw IME byte — claude recognises it
  //     as "submit" rather than a newline character.
  // (b) Delete the default Status chip — user-requested removal from defaults.
  //     The workspace.getActivityStatus action itself is NOT removed.
  //     Matches on label + icon + action_id + old params to avoid touching
  //     user-customised rows that happen to share the same label.
  if (currentVersion < 46) {
    const updateSlash = db.prepare(
      `UPDATE footer_actions_global
       SET params_json = ?, updated_at = ?
       WHERE label = ? AND action_id = 'terminal.sendInput' AND params_json = ?`
    )
    const now = Date.now()
    const slashMigrationsTx = db.transaction(() => {
      updateSlash.run(
        JSON.stringify({ text: '/copy', submit: true }),
        now,
        '/copy',
        JSON.stringify({ text: '/copy\r' })
      )
      updateSlash.run(
        JSON.stringify({ text: '/context', submit: true }),
        now,
        '/context',
        JSON.stringify({ text: '/context\r' })
      )
      updateSlash.run(
        JSON.stringify({ text: '/clear', submit: true }),
        now,
        '/clear',
        JSON.stringify({ text: '/clear\r' })
      )
    })
    try {
      slashMigrationsTx()
    } catch {
      /* footer_actions_global may not exist on a pre-v44 clean install — safe to skip */
    }

    // Remove the default Status chip; preserve user-created rows with the same label
    try {
      db.prepare(
        `DELETE FROM footer_actions_global
         WHERE label = 'Status' AND icon = 'Pulse' AND action_id = 'workspace.getActivityStatus'`
      ).run()
    } catch {
      /* safe to skip if table doesn't exist */
    }

    db.prepare('UPDATE schema_version SET version = ?').run(46)
  }
```

#### v47 (block spans lines 1860-1885)

```ts
  // Version 47: scrub Archive and Rename rows from the global footer action seed.
  // These actions were seeded in intermediate dev builds before the phase 3a clean
  // seed (v44+). workspace.archive has no broadcast event so the sidebar doesn't
  // update; workspace.rename has no UI prompt for the new name so it's useless as
  // a quick-action. Both are dropped from defaults; users can re-add via Settings
  // once the proper lifecycle is wired. Matches on label + action_id to avoid
  // touching any user-customised rows with different icons or labels.
  if (currentVersion < 47) {
    try {
      db.prepare(
        `DELETE FROM footer_actions_global
         WHERE label = 'Archive' AND action_id = 'workspace.archive'`
      ).run()
    } catch {
      /* safe to skip if table doesn't exist */
    }
    try {
      db.prepare(
        `DELETE FROM footer_actions_global
         WHERE label = 'Rename' AND action_id = 'workspace.rename'`
      ).run()
    } catch {
      /* safe to skip if table doesn't exist */
    }
    db.prepare('UPDATE schema_version SET version = ?').run(47)
  }
```

#### v48 (block spans lines 1887-1962) — seeds `/compact`, `/cost`, `/model`; guarded by `PREV_DEFAULT_LABELS`

```ts
  // Version 48: Seed three new global footer action chips (/compact, /cost, /model).
  // Only inserts if the current global table matches the previous default set exactly:
  // Fork + /copy + /context + /clear + Context = 5 rows with those exact labels.
  // If user has customised (count ≠ 5 or labels differ), skips silently.
  if (currentVersion < 48) {
    try {
      type LabelRow = { label: string }
      const rows = db
        .prepare('SELECT label FROM footer_actions_global ORDER BY position ASC')
        .all() as LabelRow[]
      const labels = rows.map((r) => r.label)
      const PREV_DEFAULT_LABELS = ['Fork', '/copy', '/context', '/clear', 'Context']
      const matchesPrevDefault =
        labels.length === PREV_DEFAULT_LABELS.length &&
        PREV_DEFAULT_LABELS.every((lbl, i) => labels[i] === lbl)

      if (matchesPrevDefault) {
        const now = Date.now()
        // Insert at positions 4, 5, 6 (before 'Context' at 4 — shift it to 7).
        // First shift 'Context' to position 7.
        db.prepare(
          `UPDATE footer_actions_global SET position = 7 WHERE label = 'Context' AND action_id = 'session.getUsage'`
        ).run()

        const insertSeed = db.prepare(`
          INSERT INTO footer_actions_global
            (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        const seedTx = db.transaction(() => {
          insertSeed.run(
            randomUUID(),
            '/compact',
            'ArrowsInLineHorizontal',
            'terminal.sendInput',
            JSON.stringify({ text: '/compact', submit: true }),
            'idle',
            4,
            now,
            now
          )
          insertSeed.run(
            randomUUID(),
            '/cost',
            'CurrencyDollar',
            'terminal.sendInput',
            JSON.stringify({ text: '/cost', submit: true }),
            'always',
            5,
            now,
            now
          )
          insertSeed.run(
            randomUUID(),
            '/model',
            'Robot',
            'terminal.sendInput',
            JSON.stringify({ text: '/model', submit: true }),
            'always',
            6,
            now,
            now
          )
        })
        seedTx()
        console.log('[db] v48: inserted /compact, /cost, /model footer action seeds')
      } else {
        console.log('[db] v48: footer actions customised — skipping seed insertion')
      }
    } catch (err) {
      /* footer_actions_global may not exist or table is in an unexpected state — skip */
      console.warn('[db] v48: footer action seed skipped:', err)
    }
    db.prepare('UPDATE schema_version SET version = ?').run(48)
  }
```

#### v49 (block spans lines 1964-2069) — adds `prompts_json` column to all 3 footer tables + seeds `Archive`/`Rename`; guarded by `V48_DEFAULT_LABELS`

```ts
  // Version 49:
  // (a) Add prompts_json TEXT column to all three footer_actions_* tables.
  //     Defensive try/catch — fresh installs already have it via FOOTER_ACTIONS_SCHEMA_SQL.
  // (b) Seed Archive and Rename global footer action chips, but ONLY if the current
  //     global table matches the v48 default set exactly (8 rows in order):
  //       Fork, /copy, /context, /clear, /compact, /cost, /model, Context
  //     If the user has customised the table, skip silently.
  if (currentVersion < 49) {
    // (a) Add prompts_json column
    try {
      db.exec('ALTER TABLE footer_actions_global ADD COLUMN prompts_json TEXT')
    } catch {
      /* already exists on fresh install */
    }
    try {
      db.exec('ALTER TABLE footer_actions_project ADD COLUMN prompts_json TEXT')
    } catch {
      /* already exists */
    }
    try {
      db.exec('ALTER TABLE footer_actions_workspace ADD COLUMN prompts_json TEXT')
    } catch {
      /* already exists */
    }

    // (b) Seed Archive + Rename if the table still has the v48 default set.
    try {
      type LabelRow = { label: string; position: number }
      const rows = db
        .prepare('SELECT label, position FROM footer_actions_global ORDER BY position ASC')
        .all() as LabelRow[]
      const labels = rows.map((r) => r.label)
      const V48_DEFAULT_LABELS = [
        'Fork',
        '/copy',
        '/context',
        '/clear',
        '/compact',
        '/cost',
        '/model',
        'Context'
      ]
      const matchesV48Default =
        labels.length === V48_DEFAULT_LABELS.length &&
        V48_DEFAULT_LABELS.every((lbl, i) => labels[i] === lbl)

      if (matchesV48Default) {
        const now = Date.now()
        // Archive and Rename go between /model (position 6) and Context (position 7).
        // Shift Context from 7 → 9.
        db.prepare(
          `UPDATE footer_actions_global SET position = 9 WHERE label = 'Context' AND action_id = 'session.getUsage'`
        ).run()

        const insertSeed = db.prepare(`
          INSERT INTO footer_actions_global
            (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        const renamePrompts = JSON.stringify([
          {
            key: 'name',
            label: 'New name',
            placeholder: 'Workspace name',
            default: '{workspaceName}'
          }
        ])

        const seedV49Tx = db.transaction(() => {
          insertSeed.run(
            randomUUID(),
            'Archive',
            'Archive',
            'workspace.archive',
            JSON.stringify({}),
            'idle',
            7,
            now,
            now,
            null
          )
          insertSeed.run(
            randomUUID(),
            'Rename',
            'PencilSimple',
            'workspace.rename',
            JSON.stringify({}),
            'idle',
            8,
            now,
            now,
            renamePrompts
          )
        })
        seedV49Tx()
        console.log('[db] v49: inserted Archive and Rename footer action seeds')
      } else {
        console.log('[db] v49: footer actions customised — skipping Archive/Rename seed insertion')
      }
    } catch (err) {
      console.warn('[db] v49: footer action seed skipped:', err)
    }

    db.prepare('UPDATE schema_version SET version = ?').run(49)
  }
```

**Confirmed origin versions: v46, v47, v48, v49 — four discrete `if (currentVersion < N)` blocks, exactly matching the expected v46-v49 span.** No discrepancy in version numbering. Note for a refactor: v47 (Archive/Rename removal) is a pure DELETE with no default-label array guard — it is textually "between" v46 and v48/v49 in the reconciliation story but has no `PREV_DEFAULT_LABELS`/`V48_DEFAULT_LABELS`-style guard of its own; it always runs its two `DELETE` statements unconditionally (guarded only by try/catch for table existence, not by a label-set match).

---

## Anomalies / notes for the refactor

- **`healWorkspacesCheck`** (line 2334) and **`healProjectsArchivedAt`** (line 2320) are **not version-gated migrations** — they run unconditionally on every `migrate()` call, before the fast-path `if (currentVersion === CURRENT_VERSION) return`. A refactored migration engine needs an equivalent "heal on every boot regardless of version" hook, not just a linear version-gated migration list.
- `healWorkspacesCheck` does a full copy-migration (`CREATE workspaces_new` → `INSERT ... SELECT` with a `CASE` remap → `DROP TABLE workspaces` → `RENAME`) wrapped in `db.pragma('foreign_keys = OFF')` / `db.transaction(...)` / restore `foreign_keys = ON` in a `finally`. This is the only "table rebuild" pattern in the file — everything else is additive `ALTER TABLE ADD COLUMN` (never `DROP COLUMN` outside of the now-historical v3/v4 drops).
- The `keep_awake_settings` table's `CREATE TABLE` constant is followed by a seed `INSERT OR IGNORE` **inside the same string constant** (`KEEP_AWAKE_SCHEMA_SQL`, lines 374-383) — this is the only fresh-install constant that bundles a seed insert alongside its DDL.
- `diagnostics_events` is unusual in that its `DIAGNOSTICS_SCHEMA_SQL` constant is `db.exec`'d twice defensively: unconditionally near the top of `migrate()` (line 442) AND again inside the `if (currentVersion < 55)` block (line 2176) — both are harmless no-ops given `CREATE TABLE IF NOT EXISTS`.
- Every version-gated `ALTER TABLE ADD COLUMN` in the file is wrapped in `try { } catch { /* ignore */ }` — the file relies entirely on catching the "duplicate column" SQLite error rather than checking `pragma_table_info` first (except the two heal functions, which do check `pragma_table_info`/`sqlite_master` explicitly).
- `CURRENT_VERSION = 63` at capture time; the highest version-gated block in the file is `if (currentVersion < 63)` (lines 2287-2298), consistent.
- Table count matches the 13 tables requested in the task brief exactly — no extra or missing tables were found among `schema_version`, `projects`, `sessions`, `workspaces`, `claude_global_settings`, `claude_project_settings`, `claude_workspace_settings`, `app_ui_state`, `action_audit_log`, `diagnostics_events`, `footer_actions_global`, `footer_actions_project`, `footer_actions_workspace`, `keep_awake_settings` (14 listed here because the brief's list already included all 14 — recount: schema_version, projects, sessions, workspaces, claude_global_settings, claude_project_settings, claude_workspace_settings, app_ui_state, action_audit_log, diagnostics_events, footer_actions_global, footer_actions_project, footer_actions_workspace, keep_awake_settings = 14 tables, not 13; the brief's prose said "these tables" and listed 14 bullet items).
- No data transforms beyond the 5 requested were found that mutate row *data* (as opposed to schema/DDL) at scale — the v48/v49 footer seed INSERTs and v45 icon-name UPDATEs are the only non-trivial row-level writes in the whole migration history; all other version blocks are pure `ALTER TABLE ADD COLUMN` / `CREATE INDEX` / `CREATE TABLE IF NOT EXISTS`.
