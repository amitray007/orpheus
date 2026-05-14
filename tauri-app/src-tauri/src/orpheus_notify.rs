// Unix socket server for the orpheus-notify shim — mirrors src/main/orpheusNotify.ts.
//
// The bash shim sends HTTP POST /notify over a Unix domain socket.
// Protocol (v2): workspaceId + event in X-Workspace-Id / X-Event headers,
// body is the raw claude hook JSON payload.
// Protocol (v1 fallback): workspaceId + event in JSON body.
//
// This module:
// 1. Binds a UnixListener at ~/Library/Application Support/Orpheus/notify.sock
// 2. Accepts connections, parses HTTP, dispatches to handle_hook_event
// 3. Updates workspace status via workspaces::set_workspace_status
// 4. Manages in-progress watchdog timers via tokio
// 5. Emits events to the renderer — stubbed as log statements for Phase 3

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::mpsc;
use tokio::time::sleep;

use tauri::Emitter;

use crate::db::Db;
use crate::workspaces::{set_workspace_status, WorkspaceStatus};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceActivityEvent {
    SessionStart,
    UserPrompt,
    Notification,
    Stop,
    SessionEnd,
    Pretool,
    Posttool,
    Precompact,
    SubagentStop,
}

impl WorkspaceActivityEvent {
    pub fn from_hook_name(name: &str) -> Option<Self> {
        match name {
            "session-start" | "SessionStart" => Some(Self::SessionStart),
            "user-prompt" | "UserPromptSubmit" => Some(Self::UserPrompt),
            "notification" | "Notification" => Some(Self::Notification),
            "stop" | "Stop" => Some(Self::Stop),
            "session-end" | "SessionEnd" => Some(Self::SessionEnd),
            "pretool" | "PreToolUse" => Some(Self::Pretool),
            "posttool" | "PostToolUse" => Some(Self::Posttool),
            "precompact" | "PreCompact" => Some(Self::Precompact),
            "subagent-stop" | "SubagentStop" => Some(Self::SubagentStop),
            _ => None,
        }
    }

    pub fn to_status(&self) -> Option<WorkspaceStatus> {
        match self {
            Self::SessionStart => Some(WorkspaceStatus::AwaitingInput),
            Self::UserPrompt => Some(WorkspaceStatus::InProgress),
            Self::Notification => Some(WorkspaceStatus::Attention),
            Self::Stop => Some(WorkspaceStatus::AwaitingInput),
            Self::SessionEnd => Some(WorkspaceStatus::Idle),
            _ => None,
        }
    }
}

/// Detail state tracked per workspace (mirrors DetailState in TS).
#[derive(Debug, Default, Clone)]
pub struct WorkspaceDetail {
    pub tool_stack: i32,
    pub compacting: bool,
    pub blocking_tool: Option<String>,
}

/// Tools that put Claude into attention/asking state.
const BLOCKING_TOOLS: &[&str] = &["AskUserQuestion", "ExitPlanMode"];

// ---------------------------------------------------------------------------
// ActivityMap — shared state across the socket server tasks
// ---------------------------------------------------------------------------

pub type ActivityMap = Arc<Mutex<HashMap<String, WorkspaceStatus>>>;
pub type DetailMap = Arc<Mutex<HashMap<String, WorkspaceDetail>>>;

/// Computes the activity detail label for a workspace.
pub fn compute_detail(status: &WorkspaceStatus, detail: &WorkspaceDetail) -> &'static str {
    match status {
        WorkspaceStatus::Attention => {
            if detail.blocking_tool.is_some() { "asking" } else { "attention" }
        }
        WorkspaceStatus::InProgress => {
            if detail.compacting { "compacting" }
            else if detail.tool_stack > 0 { "tool" }
            else { "thinking" }
        }
        WorkspaceStatus::AwaitingInput => "ready",
        WorkspaceStatus::Idle => "idle",
        WorkspaceStatus::Archived => "archived",
    }
}

// ---------------------------------------------------------------------------
// Socket path
// ---------------------------------------------------------------------------

/// Returns the socket path: ~/Library/Application Support/Orpheus/notify.sock
/// Mirrors db_path's BaseDirs derivation so socket + DB sit side-by-side in
/// the same Electron-compatible directory.
pub fn notify_sock_path() -> Option<PathBuf> {
    let base = directories::BaseDirs::new()?;
    Some(base.data_dir().join("Orpheus").join("notify.sock"))
}

// ---------------------------------------------------------------------------
// HTTP-over-Unix-socket parser (minimal — handles the shim's POST requests)
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct ParsedRequest {
    method: String,
    path: String,
    workspace_id: Option<String>,
    event: Option<String>,
    body: String,
}

/// Read one HTTP/1.x request from the reader. Returns None on disconnect.
async fn read_http_request<R>(reader: &mut BufReader<R>) -> Option<ParsedRequest>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut req = ParsedRequest::default();
    let mut line = String::new();

    // Read request line
    if reader.read_line(&mut line).await.ok()? == 0 {
        return None;
    }
    let parts: Vec<&str> = line.trim_end().splitn(3, ' ').collect();
    if parts.len() < 2 {
        return None;
    }
    req.method = parts[0].to_owned();
    req.path = parts[1].to_owned();

    // Read headers
    let mut content_length: usize = 0;
    loop {
        line.clear();
        if reader.read_line(&mut line).await.ok()? == 0 {
            break;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break; // end of headers
        }
        let lower = trimmed.to_lowercase();
        if lower.starts_with("x-workspace-id:") {
            req.workspace_id = Some(trimmed[15..].trim().to_owned());
        } else if lower.starts_with("x-event:") {
            req.event = Some(trimmed[8..].trim().to_owned());
        } else if lower.starts_with("content-length:") {
            content_length = trimmed[15..].trim().parse().unwrap_or(0);
        }
    }

    // Read body
    if content_length > 0 {
        let mut buf = vec![0u8; content_length];
        use tokio::io::AsyncReadExt;
        let _ = reader.read_exact(&mut buf).await;
        req.body = String::from_utf8_lossy(&buf).into_owned();
    }

    Some(req)
}

// ---------------------------------------------------------------------------
// Watchdog timer management
// ---------------------------------------------------------------------------

/// Message sent from watchdog tasks back to the dispatcher.
#[derive(Debug)]
enum WatchdogMsg {
    Fired { workspace_id: String },
}

// ---------------------------------------------------------------------------
// Hook event dispatcher (pure logic, no I/O — testable in isolation)
// ---------------------------------------------------------------------------

/// Process one hook event, mutating activity_map and detail_map.
/// Returns the new status if a status change occurred.
pub fn handle_hook_event(
    workspace_id: &str,
    ev: &WorkspaceActivityEvent,
    payload: &serde_json::Value,
    activity_map: &mut HashMap<String, WorkspaceStatus>,
    detail_map: &mut HashMap<String, WorkspaceDetail>,
) -> Option<WorkspaceStatus> {
    let ds = detail_map
        .entry(workspace_id.to_owned())
        .or_insert_with(WorkspaceDetail::default);

    let tool_name: Option<&str> = payload.get("tool_name").and_then(|v| v.as_str());

    match ev {
        WorkspaceActivityEvent::Pretool => {
            if let Some(tn) = tool_name {
                if BLOCKING_TOOLS.contains(&tn) {
                    ds.blocking_tool = Some(tn.to_owned());
                    return update_status(workspace_id, WorkspaceStatus::Attention, activity_map);
                }
            }
            ds.tool_stack += 1;
            // heartbeat only — no status change for pretool
            return None;
        }
        WorkspaceActivityEvent::Posttool => {
            if let Some(tn) = tool_name {
                if ds.blocking_tool.as_deref() == Some(tn) {
                    ds.blocking_tool = None;
                    return update_status(workspace_id, WorkspaceStatus::InProgress, activity_map);
                }
            }
            ds.tool_stack = (ds.tool_stack - 1).max(0);
            return None;
        }
        WorkspaceActivityEvent::Precompact => {
            ds.compacting = true;
            return None;
        }
        WorkspaceActivityEvent::SubagentStop => {
            // heartbeat — no status change
            return None;
        }
        WorkspaceActivityEvent::UserPrompt
        | WorkspaceActivityEvent::Stop
        | WorkspaceActivityEvent::SessionEnd => {
            ds.tool_stack = 0;
            ds.compacting = false;
            ds.blocking_tool = None;
        }
        WorkspaceActivityEvent::Notification => {
            ds.compacting = false;
        }
        WorkspaceActivityEvent::SessionStart => {}
    }

    ev.to_status()
        .and_then(|status| update_status(workspace_id, status, activity_map))
}

fn update_status(
    workspace_id: &str,
    new_status: WorkspaceStatus,
    activity_map: &mut HashMap<String, WorkspaceStatus>,
) -> Option<WorkspaceStatus> {
    let prev = activity_map.get(workspace_id).cloned();
    if prev.as_ref() == Some(&new_status) {
        return None;
    }
    activity_map.insert(workspace_id.to_owned(), new_status.clone());
    Some(new_status)
}

// ---------------------------------------------------------------------------
// Socket server
// ---------------------------------------------------------------------------

/// Start the Unix socket server. Returns a JoinHandle the caller can abort.
/// `db` is used for workspace status writes; `watchdog_sec` mirrors inProgressWatchdogSec.
/// `app_handle` is used to emit `workspace:activityChanged` events to the renderer.
pub fn start_socket_server(
    db: Arc<Mutex<Db>>,
    watchdog_sec: u64,
    app_handle: tauri::AppHandle,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let sock_path = match notify_sock_path() {
            Some(p) => p,
            None => {
                eprintln!("[orpheus-notify] cannot determine socket path");
                return;
            }
        };

        let sock_path_str = sock_path.to_string_lossy();
        if sock_path_str.len() > 104 {
            eprintln!(
                "[orpheus-notify] socket path too long for macOS ({} > 104): {}",
                sock_path_str.len(),
                sock_path.display()
            );
            return;
        }

        // Remove stale socket
        let _ = std::fs::remove_file(&sock_path);
        if let Some(dir) = sock_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }

        let listener = match UnixListener::bind(&sock_path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[orpheus-notify] bind failed: {e}");
                return;
            }
        };

        let activity_map: ActivityMap = Arc::new(Mutex::new(HashMap::new()));
        let detail_map: DetailMap = Arc::new(Mutex::new(HashMap::new()));

        // Watchdog fire channel
        let (wd_tx, mut wd_rx) = mpsc::unbounded_channel::<WatchdogMsg>();

        // Watchdog receiver task
        {
            let activity_map = activity_map.clone();
            let detail_map = detail_map.clone();
            let db = db.clone();
            tokio::spawn(async move {
                while let Some(msg) = wd_rx.recv().await {
                    let WatchdogMsg::Fired { workspace_id } = msg;
                    let is_in_progress = activity_map
                        .lock()
                        .unwrap()
                        .get(&workspace_id)
                        .map(|s| s == &WorkspaceStatus::InProgress)
                        .unwrap_or(false);
                    if is_in_progress {
                        eprintln!("[orpheus-notify] watchdog fired for {workspace_id}");
                        let mut am = activity_map.lock().unwrap();
                        let mut dm = detail_map.lock().unwrap();
                        handle_hook_event(
                            &workspace_id,
                            &WorkspaceActivityEvent::Stop,
                            &serde_json::Value::Null,
                            &mut am,
                            &mut dm,
                        );
                        let db = db.lock().unwrap();
                        let _ = set_workspace_status(&db, &workspace_id, WorkspaceStatus::AwaitingInput);
                    }
                }
            });
        }

        eprintln!("[orpheus-notify] listening on {}", sock_path.display());

        loop {
            let (stream, _) = match listener.accept().await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[orpheus-notify] accept error: {e}");
                    continue;
                }
            };

            let activity_map = activity_map.clone();
            let detail_map = detail_map.clone();
            let db = db.clone();
            let wd_tx = wd_tx.clone();
            let app_handle = app_handle.clone();

            tokio::spawn(async move {
                handle_connection(stream, activity_map, detail_map, db, wd_tx, watchdog_sec, app_handle).await;
            });
        }
    })
}

async fn handle_connection(
    stream: tokio::net::UnixStream,
    activity_map: ActivityMap,
    detail_map: DetailMap,
    db: Arc<Mutex<Db>>,
    wd_tx: mpsc::UnboundedSender<WatchdogMsg>,
    watchdog_sec: u64,
    app_handle: tauri::AppHandle,
) {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);

    let req = match read_http_request(&mut reader).await {
        Some(r) => r,
        None => return,
    };

    // Always respond 204 immediately (mirrors TS behaviour)
    let _ = write_half
        .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
        .await;

    if req.method != "POST" || req.path != "/notify" {
        return;
    }

    // Parse workspaceId + eventName
    let (workspace_id, event_name) =
        if let (Some(wid), Some(ev)) = (req.workspace_id, req.event) {
            (wid, ev)
        } else if !req.body.is_empty() {
            // v1 fallback: metadata in JSON body
            if let Ok(body) = serde_json::from_str::<serde_json::Value>(&req.body) {
                let wid = body
                    .get("workspaceId")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_owned());
                let ev = body
                    .get("event")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_owned());
                match (wid, ev) {
                    (Some(w), Some(e)) => (w, e),
                    _ => return,
                }
            } else {
                return;
            }
        } else {
            return;
        };

    let event = match WorkspaceActivityEvent::from_hook_name(&event_name) {
        Some(e) => e,
        None => return,
    };

    let payload: serde_json::Value = if !req.body.is_empty() {
        serde_json::from_str(&req.body).unwrap_or(serde_json::Value::Null)
    } else {
        serde_json::Value::Null
    };

    eprintln!("[orpheus-notify] event {:?} for {}", event, workspace_id);

    let new_status = {
        let mut am = activity_map.lock().unwrap();
        let mut dm = detail_map.lock().unwrap();
        handle_hook_event(&workspace_id, &event, &payload, &mut am, &mut dm)
    };

    if let Some(status) = new_status {
        let db = db.lock().unwrap();
        if let Err(e) = set_workspace_status(&db, &workspace_id, status.clone()) {
            eprintln!("[orpheus-notify] set_workspace_status failed for {workspace_id}: {e}");
        }

        // Arm watchdog when moving to in_progress
        if status == WorkspaceStatus::InProgress && watchdog_sec > 0 {
            let workspace_id = workspace_id.clone();
            let wd_tx = wd_tx.clone();
            let delay = Duration::from_secs(watchdog_sec);
            tokio::spawn(async move {
                sleep(delay).await;
                let _ = wd_tx.send(WatchdogMsg::Fired { workspace_id });
            });
        }

        // Emit workspace:activityChanged so the renderer can update status badges.
        let detail = {
            let dm = detail_map.lock().unwrap();
            let d = dm.get(&workspace_id).cloned().unwrap_or_default();
            compute_detail(&status, &d)
        };
        let _ = app_handle.emit(
            "workspace:activityChanged",
            serde_json::json!({
                "workspaceId": workspace_id,
                "status": status.as_str(),
                "detail": detail,
            }),
        );
        log::debug!("[orpheus-notify] status -> {:?} for {}", status, workspace_id);
    }
}

// ---------------------------------------------------------------------------
// ensure_managed_hooks — mirrors ensureManagedHooks in TS
// ---------------------------------------------------------------------------

const HOOK_EVENT_MAP: &[(&str, &str)] = &[
    ("SessionStart", "session-start"),
    ("UserPromptSubmit", "user-prompt"),
    ("Notification", "notification"),
    ("Stop", "stop"),
    ("SessionEnd", "session-end"),
    ("PreToolUse", "pretool"),
    ("PostToolUse", "posttool"),
    ("PreCompact", "precompact"),
    ("SubagentStop", "subagent-stop"),
];

fn managed_command(event: &str) -> String {
    format!(
        "[ -n \"$ORPHEUS_NOTIFY\" ] && [ -x \"$ORPHEUS_NOTIFY\" ] && \"$ORPHEUS_NOTIFY\" {event} || true"
    )
}

fn is_managed_command(cmd: &str) -> bool {
    cmd.contains("$ORPHEUS_NOTIFY")
}

/// Write Orpheus hook commands into ~/.claude/settings.json.
/// Idempotent — existing managed entries are replaced, foreign entries preserved.
pub fn ensure_managed_hooks() -> Result<(), crate::claude_hooks::ClaudeHookError> {
    use crate::claude_hooks::atomic_write;
    use serde_json::{json, Map, Value as JsonValue};

    let settings_path = directories::UserDirs::new()
        .map(|u| u.home_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("settings.json");

    if let Some(dir) = settings_path.parent() {
        std::fs::create_dir_all(dir)?;
    }

    let mut parsed: Map<String, JsonValue> = match std::fs::read_to_string(&settings_path) {
        Ok(raw) => match serde_json::from_str::<JsonValue>(&raw) {
            Ok(JsonValue::Object(m)) => m,
            _ => Map::new(),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(e) => {
            eprintln!("[orpheus-notify] could not read settings.json: {e}");
            return Ok(());
        }
    };

    let hooks_obj = parsed
        .entry("hooks")
        .or_insert_with(|| JsonValue::Object(Map::new()))
        .as_object_mut()
        .expect("hooks is object");

    for (hook_event, activity_event) in HOOK_EVENT_MAP {
        let event_arr = hooks_obj
            .entry(*hook_event)
            .or_insert_with(|| JsonValue::Array(vec![]))
            .as_array_mut()
            .expect("event entry is array");

        // Remove any existing managed entries
        event_arr.retain(|entry| {
            let hook_list = entry.get("hooks").and_then(|v| v.as_array());
            let has_ours = hook_list.map_or(false, |hooks| {
                hooks.iter().any(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map_or(false, is_managed_command)
                })
            });
            !has_ours
        });

        event_arr.push(json!({
            "hooks": [{ "type": "command", "command": managed_command(activity_event) }]
        }));
    }

    let content = serde_json::to_string_pretty(&JsonValue::Object(parsed)).unwrap();
    atomic_write(&settings_path, &content)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn make_maps() -> (HashMap<String, WorkspaceStatus>, HashMap<String, WorkspaceDetail>) {
        (HashMap::new(), HashMap::new())
    }

    #[test]
    fn session_start_sets_awaiting_input() {
        let (mut am, mut dm) = make_maps();
        let status = handle_hook_event(
            "ws1",
            &WorkspaceActivityEvent::SessionStart,
            &serde_json::Value::Null,
            &mut am,
            &mut dm,
        );
        assert_eq!(status, Some(WorkspaceStatus::AwaitingInput));
        assert_eq!(am.get("ws1"), Some(&WorkspaceStatus::AwaitingInput));
    }

    #[test]
    fn user_prompt_sets_in_progress() {
        let (mut am, mut dm) = make_maps();
        let status = handle_hook_event(
            "ws1",
            &WorkspaceActivityEvent::UserPrompt,
            &serde_json::Value::Null,
            &mut am,
            &mut dm,
        );
        assert_eq!(status, Some(WorkspaceStatus::InProgress));
    }

    #[test]
    fn stop_sets_awaiting_input() {
        let (mut am, mut dm) = make_maps();
        am.insert("ws1".into(), WorkspaceStatus::InProgress);
        let status = handle_hook_event(
            "ws1",
            &WorkspaceActivityEvent::Stop,
            &serde_json::Value::Null,
            &mut am,
            &mut dm,
        );
        assert_eq!(status, Some(WorkspaceStatus::AwaitingInput));
    }

    #[test]
    fn same_status_returns_none() {
        let (mut am, mut dm) = make_maps();
        am.insert("ws1".into(), WorkspaceStatus::AwaitingInput);
        let status = handle_hook_event(
            "ws1",
            &WorkspaceActivityEvent::Stop,
            &serde_json::Value::Null,
            &mut am,
            &mut dm,
        );
        // Stop maps to awaiting_input — already there, so no change
        assert_eq!(status, None);
    }

    #[test]
    fn pretool_blocking_sets_attention() {
        let (mut am, mut dm) = make_maps();
        am.insert("ws1".into(), WorkspaceStatus::InProgress);
        let payload = serde_json::json!({"tool_name": "AskUserQuestion"});
        let status = handle_hook_event(
            "ws1",
            &WorkspaceActivityEvent::Pretool,
            &payload,
            &mut am,
            &mut dm,
        );
        assert_eq!(status, Some(WorkspaceStatus::Attention));
        assert_eq!(dm.get("ws1").unwrap().blocking_tool.as_deref(), Some("AskUserQuestion"));
    }

    #[test]
    fn posttool_clears_blocking_tool() {
        let (mut am, mut dm) = make_maps();
        am.insert("ws1".into(), WorkspaceStatus::Attention);
        dm.insert("ws1".into(), WorkspaceDetail {
            blocking_tool: Some("AskUserQuestion".into()),
            tool_stack: 0,
            compacting: false,
        });
        let payload = serde_json::json!({"tool_name": "AskUserQuestion"});
        let status = handle_hook_event(
            "ws1",
            &WorkspaceActivityEvent::Posttool,
            &payload,
            &mut am,
            &mut dm,
        );
        assert_eq!(status, Some(WorkspaceStatus::InProgress));
        assert!(dm.get("ws1").unwrap().blocking_tool.is_none());
    }

    #[test]
    fn pretool_non_blocking_increments_stack() {
        let (mut am, mut dm) = make_maps();
        am.insert("ws1".into(), WorkspaceStatus::InProgress);
        let payload = serde_json::json!({"tool_name": "Bash"});
        let status = handle_hook_event(
            "ws1",
            &WorkspaceActivityEvent::Pretool,
            &payload,
            &mut am,
            &mut dm,
        );
        // Non-blocking pretool: no status change
        assert_eq!(status, None);
        assert_eq!(dm.get("ws1").unwrap().tool_stack, 1);
    }

    #[test]
    fn compute_detail_thinking() {
        let detail = WorkspaceDetail::default();
        assert_eq!(compute_detail(&WorkspaceStatus::InProgress, &detail), "thinking");
    }

    #[test]
    fn compute_detail_tool() {
        let detail = WorkspaceDetail { tool_stack: 1, ..Default::default() };
        assert_eq!(compute_detail(&WorkspaceStatus::InProgress, &detail), "tool");
    }

    #[test]
    fn compute_detail_compacting() {
        let detail = WorkspaceDetail { compacting: true, tool_stack: 1, ..Default::default() };
        assert_eq!(compute_detail(&WorkspaceStatus::InProgress, &detail), "compacting");
    }

    #[test]
    fn compute_detail_asking() {
        let detail = WorkspaceDetail {
            blocking_tool: Some("AskUserQuestion".into()),
            ..Default::default()
        };
        assert_eq!(compute_detail(&WorkspaceStatus::Attention, &detail), "asking");
    }

    #[test]
    fn hook_event_names_round_trip() {
        let cases = [
            ("session-start", WorkspaceActivityEvent::SessionStart),
            ("SessionStart", WorkspaceActivityEvent::SessionStart),
            ("PreToolUse", WorkspaceActivityEvent::Pretool),
            ("pretool", WorkspaceActivityEvent::Pretool),
            ("SubagentStop", WorkspaceActivityEvent::SubagentStop),
        ];
        for (name, expected) in cases {
            assert_eq!(
                WorkspaceActivityEvent::from_hook_name(name),
                Some(expected),
                "name={name}"
            );
        }
        assert_eq!(WorkspaceActivityEvent::from_hook_name("unknown"), None);
    }

    #[test]
    fn precompact_sets_compacting_flag() {
        let (mut am, mut dm) = make_maps();
        am.insert("ws1".into(), WorkspaceStatus::InProgress);
        handle_hook_event(
            "ws1",
            &WorkspaceActivityEvent::Precompact,
            &serde_json::Value::Null,
            &mut am,
            &mut dm,
        );
        assert!(dm.get("ws1").unwrap().compacting);
    }

    #[test]
    fn stop_clears_detail_state() {
        let (mut am, mut dm) = make_maps();
        am.insert("ws1".into(), WorkspaceStatus::InProgress);
        dm.insert("ws1".into(), WorkspaceDetail {
            tool_stack: 3,
            compacting: true,
            blocking_tool: Some("SomeTool".into()),
        });
        handle_hook_event(
            "ws1",
            &WorkspaceActivityEvent::Stop,
            &serde_json::Value::Null,
            &mut am,
            &mut dm,
        );
        let d = dm.get("ws1").unwrap();
        assert_eq!(d.tool_stack, 0);
        assert!(!d.compacting);
        assert!(d.blocking_tool.is_none());
    }

    /// Verify the pure dispatch loop + DB write round-trip.
    #[tokio::test]
    async fn socket_server_processes_event() {
        use crate::db::Db;

        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.sqlite");
        let db = Db::open_at(&db_path).unwrap();

        // Insert a project + workspace row so set_workspace_status doesn't error
        db.conn().execute(
            "INSERT INTO projects (id, path, name, added_at) VALUES ('p1', '/tmp/p1', 'P1', 0)",
            [],
        ).unwrap();
        db.conn().execute(
            "INSERT INTO workspaces (id, project_id, name, cwd, created_at) VALUES ('ws1', 'p1', 'WS1', '/tmp', 0)",
            [],
        ).unwrap();

        let mut am: HashMap<String, WorkspaceStatus> = HashMap::new();
        let mut dm: HashMap<String, WorkspaceDetail> = HashMap::new();

        // Drive: user-prompt → in_progress
        handle_hook_event(
            "ws1",
            &WorkspaceActivityEvent::UserPrompt,
            &serde_json::Value::Null,
            &mut am,
            &mut dm,
        );
        assert_eq!(am.get("ws1"), Some(&WorkspaceStatus::InProgress));

        // DB write should succeed
        let result = set_workspace_status(&db, "ws1", WorkspaceStatus::InProgress);
        assert!(result.is_ok(), "set_workspace_status failed: {:?}", result);

        // Drive: stop → awaiting_input
        handle_hook_event(
            "ws1",
            &WorkspaceActivityEvent::Stop,
            &serde_json::Value::Null,
            &mut am,
            &mut dm,
        );
        assert_eq!(am.get("ws1"), Some(&WorkspaceStatus::AwaitingInput));
    }
}
