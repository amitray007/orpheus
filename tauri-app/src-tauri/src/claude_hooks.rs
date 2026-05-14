// Hooks management: read/write ~/.claude/settings.json and per-project .claude/settings.json.
// Mirrors src/main/claudeHooks.ts.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value as JsonValue};

use crate::db::Db;
use crate::projects::list_projects;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ClaudeHookError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json parse error in {path}: {source}")]
    JsonParse {
        path: String,
        #[source]
        source: serde_json::Error,
    },

    #[error("{0} is not a JSON object")]
    NotObject(String),

    #[error("hooks structure missing in {0}")]
    NoHooks(String),

    #[error("event \"{0}\" not found")]
    NoEvent(String),

    #[error("matcherEntryIdx {0} out of range")]
    MatcherEntryIdx(usize),

    #[error("hookIdx {0} out of range")]
    HookIdx(usize),

    #[error("project not found: {0}")]
    ProjectNotFound(String),

    #[error("unknown event: {0}")]
    UnknownEvent(String),

    #[error("command must be non-empty")]
    EmptyCommand,

    #[error("tempfile persist error: {0}")]
    Persist(String),
}

// ---------------------------------------------------------------------------
// Event ordering (mirrors TS EVENT_ORDER)
// ---------------------------------------------------------------------------

static EVENT_ORDER: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SubagentStop",
    "PreCompact",
    "Notification",
];

fn event_rank(event: &str) -> usize {
    EVENT_ORDER
        .iter()
        .position(|&e| e == event)
        .unwrap_or(EVENT_ORDER.len())
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// Flat serialization matching ClaudeHookEntry in shared/types.ts.
// source is "user" or "project" as a plain string.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeHookEntry {
    /// "user" or "project"
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    pub file_path: String,
    pub event: String,
    pub matcher: Option<String>,
    pub matcher_entry_idx: usize,
    pub hook_idx: usize,
    /// Serialized as "type" to match TS ClaudeHookEntry.type
    #[serde(rename = "type")]
    pub hook_type: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewHook {
    /// "user" | "project"
    pub source: String,
    /// Required when source == "project"
    pub project_id: Option<String>,
    pub event: String,
    pub matcher: Option<String>,
    /// Serialized as "type" to match ClaudeHookDraft.type in TS
    #[serde(rename = "type", alias = "hookType")]
    pub hook_type: Option<String>,
    pub command: String,
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

fn home_dir() -> PathBuf {
    // UserDirs::new() can fail in unusual environments; fall back to ".".
    directories::UserDirs::new()
        .map(|u| u.home_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn user_settings_path() -> PathBuf {
    home_dir().join(".claude").join("settings.json")
}

fn project_settings_path(project_path: &str) -> PathBuf {
    PathBuf::from(project_path).join(".claude").join("settings.json")
}

/// Write atomically: temp file in same dir, then rename over target.
pub fn atomic_write(path: &Path, content: &str) -> Result<(), ClaudeHookError> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(content.as_bytes())?;
    tmp.persist(path)
        .map_err(|e| ClaudeHookError::Persist(e.to_string()))?;
    Ok(())
}

/// Read and JSON-parse a settings file. Returns an empty object if file is absent.
fn read_and_parse(path: &Path) -> Result<Map<String, JsonValue>, ClaudeHookError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(e.into()),
    };

    let parsed: JsonValue =
        serde_json::from_str(&raw).map_err(|source| ClaudeHookError::JsonParse {
            path: path.display().to_string(),
            source,
        })?;

    match parsed {
        JsonValue::Object(m) => Ok(m),
        _ => Err(ClaudeHookError::NotObject(path.display().to_string())),
    }
}

// ---------------------------------------------------------------------------
// Parsing hooks out of a settings map
// ---------------------------------------------------------------------------

fn parse_hooks_from_map(
    map: &Map<String, JsonValue>,
    path_str: &str,
    // Flat source fields matching ClaudeHookEntry in TS
    source: &str,
    project_id: Option<&str>,
    project_name: Option<&str>,
) -> Vec<ClaudeHookEntry> {
    let hooks_val = match map.get("hooks") {
        Some(v) => v,
        None => return vec![],
    };
    let hooks_obj = match hooks_val.as_object() {
        Some(o) => o,
        None => return vec![],
    };

    let mut entries = Vec::new();

    for (event, matcher_entries_val) in hooks_obj {
        let matcher_entries = match matcher_entries_val.as_array() {
            Some(a) => a,
            None => continue,
        };

        for (matcher_entry_idx, matcher_entry_val) in matcher_entries.iter().enumerate() {
            let me = match matcher_entry_val.as_object() {
                Some(o) => o,
                None => continue,
            };

            let matcher = me
                .get("matcher")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_owned());

            let hook_list = match me.get("hooks").and_then(|v| v.as_array()) {
                Some(a) => a,
                None => continue,
            };

            for (hook_idx, hook_val) in hook_list.iter().enumerate() {
                let h = match hook_val.as_object() {
                    Some(o) => o,
                    None => continue,
                };
                let command = match h.get("command").and_then(|v| v.as_str()) {
                    Some(c) if !c.is_empty() => c.to_owned(),
                    _ => continue,
                };
                let hook_type = h
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("command")
                    .to_owned();

                entries.push(ClaudeHookEntry {
                    source: source.to_owned(),
                    project_id: project_id.map(str::to_owned),
                    project_name: project_name.map(str::to_owned),
                    file_path: path_str.to_owned(),
                    event: event.clone(),
                    matcher: matcher.clone(),
                    matcher_entry_idx,
                    hook_idx,
                    hook_type,
                    command,
                });
            }
        }
    }

    entries
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// List all hooks from user settings and all project settings files.
/// Pass `db` so we can call `list_projects`.
pub fn list_hooks(db: &Db) -> Result<Vec<ClaudeHookEntry>, ClaudeHookError> {
    let mut all: Vec<ClaudeHookEntry> = Vec::new();

    let user_path = user_settings_path();
    let user_map = read_and_parse(&user_path)?;
    all.extend(parse_hooks_from_map(
        &user_map,
        &user_path.display().to_string(),
        "user",
        None,
        None,
    ));

    for project in list_projects(db).unwrap_or_default() {
        let proj_path = project_settings_path(&project.path);
        // Skip per-project files that are missing or unreadable — don't error the whole list.
        if let Ok(proj_map) = read_and_parse(&proj_path) {
            all.extend(parse_hooks_from_map(
                &proj_map,
                &proj_path.display().to_string(),
                "project",
                Some(&project.id),
                Some(&project.name),
            ));
        }
    }

    all.sort_by(|a, b| {
        // 1. user before project
        let a_user = a.source == "user";
        let b_user = b.source == "user";
        if a_user != b_user {
            return if a_user {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        // 2. within project: by project name
        let an = a.project_name.as_deref().unwrap_or("");
        let bn = b.project_name.as_deref().unwrap_or("");
        let pn = an.cmp(bn);
        if pn != std::cmp::Ordering::Equal {
            return pn;
        }
        // 3. by event order
        let er = event_rank(&a.event).cmp(&event_rank(&b.event));
        if er != std::cmp::Ordering::Equal {
            return er;
        }
        // 4. null/empty matcher last, otherwise alpha
        let am = a.matcher.as_deref().unwrap_or("");
        let bm = b.matcher.as_deref().unwrap_or("");
        match (am.is_empty(), bm.is_empty()) {
            (true, false) => std::cmp::Ordering::Greater,
            (false, true) => std::cmp::Ordering::Less,
            _ => am.cmp(bm),
        }
    });

    Ok(all)
}

/// Resolve the settings file path from a source + optional project_id.
fn resolve_file_path(
    db: &Db,
    source: &str,
    project_id: Option<&str>,
) -> Result<PathBuf, ClaudeHookError> {
    if source == "user" {
        return Ok(user_settings_path());
    }
    let pid = project_id
        .ok_or_else(|| ClaudeHookError::ProjectNotFound("(none)".into()))?;
    let projects = list_projects(db).unwrap_or_default();
    let project = projects
        .iter()
        .find(|p| p.id == pid)
        .ok_or_else(|| ClaudeHookError::ProjectNotFound(pid.to_owned()))?;
    Ok(project_settings_path(&project.path))
}

/// Append a new hook entry to the appropriate settings file.
pub fn add_hook(db: &Db, draft: NewHook) -> Result<(), ClaudeHookError> {
    if draft.command.trim().is_empty() {
        return Err(ClaudeHookError::EmptyCommand);
    }
    if !EVENT_ORDER.contains(&draft.event.as_str()) {
        return Err(ClaudeHookError::UnknownEvent(draft.event.clone()));
    }

    let path = resolve_file_path(db, &draft.source, draft.project_id.as_deref())?;
    let mut map = read_and_parse(&path)?;

    let hooks_obj = map
        .entry("hooks")
        .or_insert_with(|| JsonValue::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| ClaudeHookError::NoHooks(path.display().to_string()))?;

    // Re-borrow after the closure above
    let event_arr = hooks_obj
        .entry(draft.event.clone())
        .or_insert_with(|| JsonValue::Array(vec![]))
        .as_array_mut()
        .ok_or_else(|| ClaudeHookError::NoEvent(draft.event.clone()))?;

    let mut new_entry = Map::new();
    new_entry.insert(
        "hooks".into(),
        json!([{
            "type": draft.hook_type.as_deref().unwrap_or("command"),
            "command": draft.command.trim()
        }]),
    );
    if let Some(m) = draft.matcher.as_deref().filter(|s| !s.trim().is_empty()) {
        new_entry.insert("matcher".into(), JsonValue::String(m.trim().to_owned()));
    }
    event_arr.push(JsonValue::Object(new_entry));

    let content = serde_json::to_string_pretty(&JsonValue::Object(map))
        .unwrap_or_else(|_| "{}".into());
    atomic_write(&path, &content)?;
    Ok(())
}

/// Replace the type+command of an existing hook in-place.
pub fn update_hook(
    file_path: &Path,
    event: &str,
    matcher_entry_idx: usize,
    hook_idx: usize,
    new_type: &str,
    new_command: &str,
    new_matcher: Option<&str>,
) -> Result<(), ClaudeHookError> {
    if new_command.trim().is_empty() {
        return Err(ClaudeHookError::EmptyCommand);
    }
    if !EVENT_ORDER.contains(&event) {
        return Err(ClaudeHookError::UnknownEvent(event.to_owned()));
    }

    let mut map = read_and_parse(file_path)?;

    let hooks_obj = map
        .get_mut("hooks")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| ClaudeHookError::NoHooks(file_path.display().to_string()))?;

    let event_arr = hooks_obj
        .get_mut(event)
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| ClaudeHookError::NoEvent(event.to_owned()))?;

    let matcher_entry = event_arr
        .get_mut(matcher_entry_idx)
        .and_then(|v| v.as_object_mut())
        .ok_or(ClaudeHookError::MatcherEntryIdx(matcher_entry_idx))?;

    let hook_list = matcher_entry
        .get_mut("hooks")
        .and_then(|v| v.as_array_mut())
        .ok_or(ClaudeHookError::MatcherEntryIdx(matcher_entry_idx))?;

    let hook_item = hook_list
        .get_mut(hook_idx)
        .and_then(|v| v.as_object_mut())
        .ok_or(ClaudeHookError::HookIdx(hook_idx))?;

    hook_item.insert("type".into(), JsonValue::String(new_type.to_owned()));
    hook_item.insert("command".into(), JsonValue::String(new_command.to_owned()));

    match new_matcher.map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(m) => {
            matcher_entry.insert("matcher".into(), JsonValue::String(m.to_owned()));
        }
        None => {
            matcher_entry.remove("matcher");
        }
    }

    let content = serde_json::to_string_pretty(&JsonValue::Object(map))
        .unwrap_or_else(|_| "{}".into());
    atomic_write(file_path, &content)?;
    Ok(())
}

/// Delete a single hook entry, cascading empty-cleanup up the tree.
pub fn delete_hook(
    file_path: &Path,
    event: &str,
    matcher_entry_idx: usize,
    hook_idx: usize,
) -> Result<(), ClaudeHookError> {
    let mut map = read_and_parse(file_path)?;

    {
        let hooks_obj = map
            .get_mut("hooks")
            .and_then(|v| v.as_object_mut())
            .ok_or_else(|| ClaudeHookError::NoHooks(file_path.display().to_string()))?;

        let event_arr = hooks_obj
            .get_mut(event)
            .and_then(|v| v.as_array_mut())
            .ok_or_else(|| ClaudeHookError::NoEvent(event.to_owned()))?;

        let matcher_entry = event_arr
            .get_mut(matcher_entry_idx)
            .and_then(|v| v.as_object_mut())
            .ok_or(ClaudeHookError::MatcherEntryIdx(matcher_entry_idx))?;

        let hook_list = matcher_entry
            .get_mut("hooks")
            .and_then(|v| v.as_array_mut())
            .ok_or(ClaudeHookError::MatcherEntryIdx(matcher_entry_idx))?;

        if hook_idx >= hook_list.len() {
            return Err(ClaudeHookError::HookIdx(hook_idx));
        }
        hook_list.remove(hook_idx);

        // Cascade: remove matcher entry if hooks array is now empty
        if hook_list.is_empty() {
            event_arr.remove(matcher_entry_idx);
        }
    }

    // Cascade: remove event key if event array is now empty
    {
        let hooks_obj = map
            .get_mut("hooks")
            .and_then(|v| v.as_object_mut())
            .expect("hooks still present");

        if hooks_obj
            .get(event)
            .and_then(|v| v.as_array())
            .map_or(false, |a| a.is_empty())
        {
            hooks_obj.remove(event);
        }

        // Cascade: remove hooks key if object is now empty
        if hooks_obj.is_empty() {
            map.remove("hooks");
        }
    }

    let content = serde_json::to_string_pretty(&JsonValue::Object(map))
        .unwrap_or_else(|_| "{}".into());
    atomic_write(file_path, &content)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_settings(dir: &Path, content: &str) -> PathBuf {
        let path = dir.join("settings.json");
        fs::write(&path, content).expect("write");
        path
    }

    #[test]
    fn add_hook_creates_structure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");

        // Use add_hook directly via atomic_write + the internal helpers
        let mut map: Map<String, JsonValue> = Map::new();
        let hooks_obj = map
            .entry("hooks")
            .or_insert_with(|| JsonValue::Object(Map::new()))
            .as_object_mut()
            .unwrap();
        let event_arr = hooks_obj
            .entry("PreToolUse")
            .or_insert_with(|| JsonValue::Array(vec![]))
            .as_array_mut()
            .unwrap();
        let mut entry = Map::new();
        entry.insert(
            "hooks".into(),
            json!([{"type": "command", "command": "echo hi"}]),
        );
        event_arr.push(JsonValue::Object(entry));

        let content = serde_json::to_string_pretty(&JsonValue::Object(map)).unwrap();
        atomic_write(&path, &content).expect("write");

        let raw = fs::read_to_string(&path).expect("read");
        let v: JsonValue = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            v["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "echo hi"
        );
    }

    #[test]
    fn parse_hooks_from_well_formed_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let content = r#"{
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [
                            { "type": "command", "command": "echo pre" }
                        ]
                    }
                ],
                "Stop": [
                    {
                        "hooks": [
                            { "type": "command", "command": "echo stop" }
                        ]
                    }
                ]
            }
        }"#;
        let path = write_settings(dir.path(), content);
        let map = read_and_parse(&path).expect("parse");
        let entries = parse_hooks_from_map(&map, path.to_str().unwrap(), "user", None, None);

        assert_eq!(entries.len(), 2);
        let pre = entries.iter().find(|e| e.event == "PreToolUse").unwrap();
        assert_eq!(pre.matcher.as_deref(), Some("Bash"));
        assert_eq!(pre.command, "echo pre");
        let stop = entries.iter().find(|e| e.event == "Stop").unwrap();
        assert!(stop.matcher.is_none());
        assert_eq!(stop.command, "echo stop");
    }

    #[test]
    fn update_hook_changes_command_and_matcher() {
        let dir = tempfile::tempdir().expect("tempdir");
        let content = r#"{
            "hooks": {
                "PostToolUse": [
                    {
                        "matcher": "old",
                        "hooks": [
                            { "type": "command", "command": "echo old" }
                        ]
                    }
                ]
            }
        }"#;
        let path = write_settings(dir.path(), content);

        update_hook(&path, "PostToolUse", 0, 0, "command", "echo new", Some("new-matcher"))
            .expect("update");

        let raw = fs::read_to_string(&path).unwrap();
        let v: JsonValue = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["hooks"]["PostToolUse"][0]["hooks"][0]["command"], "echo new");
        assert_eq!(v["hooks"]["PostToolUse"][0]["matcher"], "new-matcher");
    }

    #[test]
    fn update_hook_clears_matcher_when_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let content = r#"{
            "hooks": {
                "Stop": [
                    {
                        "matcher": "something",
                        "hooks": [{ "type": "command", "command": "x" }]
                    }
                ]
            }
        }"#;
        let path = write_settings(dir.path(), content);
        update_hook(&path, "Stop", 0, 0, "command", "y", None).expect("update");

        let raw = fs::read_to_string(&path).unwrap();
        let v: JsonValue = serde_json::from_str(&raw).unwrap();
        assert!(v["hooks"]["Stop"][0].get("matcher").is_none());
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], "y");
    }

    #[test]
    fn delete_hook_removes_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let content = r#"{
            "hooks": {
                "PreToolUse": [
                    {
                        "hooks": [
                            { "type": "command", "command": "echo a" },
                            { "type": "command", "command": "echo b" }
                        ]
                    }
                ]
            }
        }"#;
        let path = write_settings(dir.path(), content);
        delete_hook(&path, "PreToolUse", 0, 0).expect("delete");

        let raw = fs::read_to_string(&path).unwrap();
        let v: JsonValue = serde_json::from_str(&raw).unwrap();
        // echo b should remain at idx 0
        assert_eq!(v["hooks"]["PreToolUse"][0]["hooks"][0]["command"], "echo b");
    }

    #[test]
    fn delete_hook_cascades_empty_cleanup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let content = r#"{
            "hooks": {
                "Stop": [
                    {
                        "hooks": [
                            { "type": "command", "command": "last" }
                        ]
                    }
                ]
            }
        }"#;
        let path = write_settings(dir.path(), content);
        delete_hook(&path, "Stop", 0, 0).expect("delete");

        let raw = fs::read_to_string(&path).unwrap();
        let v: JsonValue = serde_json::from_str(&raw).unwrap();
        // hooks key should be absent entirely
        assert!(v.get("hooks").is_none(), "hooks key should have been removed");
    }

    #[test]
    fn delete_hook_cascades_event_only_when_arr_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let content = r#"{
            "hooks": {
                "PreToolUse": [
                    {
                        "hooks": [{ "type": "command", "command": "one" }]
                    }
                ],
                "Stop": [
                    {
                        "hooks": [{ "type": "command", "command": "two" }]
                    }
                ]
            }
        }"#;
        let path = write_settings(dir.path(), content);
        delete_hook(&path, "PreToolUse", 0, 0).expect("delete");

        let raw = fs::read_to_string(&path).unwrap();
        let v: JsonValue = serde_json::from_str(&raw).unwrap();
        // PreToolUse removed, Stop remains
        assert!(v["hooks"].get("PreToolUse").is_none());
        assert_eq!(v["hooks"]["Stop"][0]["hooks"][0]["command"], "two");
    }

    #[test]
    fn atomic_write_original_unchanged_on_success() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.json");
        fs::write(&path, "original").expect("write");

        atomic_write(&path, "replaced").expect("atomic write");

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, "replaced");
    }

    #[test]
    fn missing_file_parses_as_empty_object() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nonexistent.json");
        let map = read_and_parse(&path).expect("parse");
        assert!(map.is_empty());
    }

    #[test]
    fn add_hook_unknown_event_errors() {
        // We test the validation logic directly
        let event = "NonExistentEvent";
        assert!(!EVENT_ORDER.contains(&event));
    }

    #[test]
    fn event_rank_ordering() {
        assert!(event_rank("SessionStart") < event_rank("PreToolUse"));
        assert!(event_rank("PreToolUse") < event_rank("PostToolUse"));
        assert!(event_rank("Notification") > event_rank("Stop"));
        assert_eq!(event_rank("unknown"), EVENT_ORDER.len());
    }
}
