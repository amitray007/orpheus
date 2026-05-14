// MCP server config management — mirrors src/main/mcp.ts.
// Reads from ~/.claude.json (user-level) and per-project .mcp.json (project-level).
// Writes use atomic_write from claude_hooks.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};

use crate::claude_hooks::atomic_write;
use crate::db::Db;
use crate::projects::list_projects;

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum McpError {
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

    #[error("server \"{0}\" not found")]
    NotFound(String),

    #[error("server \"{0}\" already exists")]
    AlreadyExists(String),

    #[error("invalid server name \"{0}\": only letters, digits, underscores, and hyphens allowed")]
    InvalidName(String),

    #[error("invalid transport \"{0}\": must be stdio, http, or sse")]
    InvalidTransport(String),

    #[error("command is required for stdio transport")]
    MissingCommand,

    #[error("url is required for {0} transport")]
    MissingUrl(String),

    #[error("project not found: {0}")]
    ProjectNotFound(String),

    #[error("~/.claude.json does not exist — run claude once to create it")]
    UserFileNotFound,

    #[error("mcpServers missing in {0}")]
    NoMcpServers(String),

    #[error("tempfile persist error: {0}")]
    Persist(String),

    #[error("db: {0}")]
    Db(#[from] crate::db::DbError),
}

// Forward atomic_write's ClaudeHookError to McpError
impl From<crate::claude_hooks::ClaudeHookError> for McpError {
    fn from(e: crate::claude_hooks::ClaudeHookError) -> Self {
        match e {
            crate::claude_hooks::ClaudeHookError::Io(io) => McpError::Io(io),
            crate::claude_hooks::ClaudeHookError::Persist(s) => McpError::Persist(s),
            other => McpError::Io(std::io::Error::new(std::io::ErrorKind::Other, other.to_string())),
        }
    }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
    Unknown,
}

impl McpTransport {
    pub fn as_str(&self) -> &'static str {
        match self {
            McpTransport::Stdio => "stdio",
            McpTransport::Http => "http",
            McpTransport::Sse => "sse",
            McpTransport::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpSource {
    User,
    Project,
}

/// A discovered MCP server entry (read-only view).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredMcpServer {
    pub name: String,
    pub transport: McpTransport,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub url: Option<String>,
    pub source: McpSource,
    pub file_path: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
}

/// A draft for adding or updating an MCP server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDraft {
    pub name: String,
    /// "stdio" | "http" | "sse"
    pub transport: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub url: Option<String>,
    pub source: String,
    pub project_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

fn home_dir() -> PathBuf {
    directories::UserDirs::new()
        .map(|u| u.home_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn user_claude_json_path() -> PathBuf {
    home_dir().join(".claude.json")
}

fn resolve_file_path(db: &Db, source: &str, project_id: Option<&str>) -> Result<PathBuf, McpError> {
    if source == "user" {
        return Ok(user_claude_json_path());
    }
    let pid = project_id.ok_or_else(|| {
        McpError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "projectId required when source is project",
        ))
    })?;
    let projects = list_projects(db)?;
    let project = projects
        .iter()
        .find(|p| p.id == pid)
        .ok_or_else(|| McpError::ProjectNotFound(pid.to_owned()))?;
    Ok(PathBuf::from(&project.path).join(".mcp.json"))
}

// ---------------------------------------------------------------------------
// JSON file I/O
// ---------------------------------------------------------------------------

fn read_json_file(path: &Path) -> Option<JsonValue> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw)
        .map_err(|e| eprintln!("[mcp] failed to parse {}: {e}", path.display()))
        .ok()
}

fn read_and_parse_user_file(path: &Path) -> Result<Map<String, JsonValue>, McpError> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            McpError::UserFileNotFound
        } else {
            McpError::Io(e)
        }
    })?;
    let val: JsonValue = serde_json::from_str(&raw).map_err(|source| McpError::JsonParse {
        path: path.display().to_string(),
        source,
    })?;
    match val {
        JsonValue::Object(m) => Ok(m),
        _ => Err(McpError::NotObject(path.display().to_string())),
    }
}

fn read_and_parse_project_file(path: &Path) -> Result<Map<String, JsonValue>, McpError> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let raw = std::fs::read_to_string(path)?;
    let val: JsonValue = serde_json::from_str(&raw).map_err(|source| McpError::JsonParse {
        path: path.display().to_string(),
        source,
    })?;
    match val {
        JsonValue::Object(m) => Ok(m),
        _ => Err(McpError::NotObject(path.display().to_string())),
    }
}

// ---------------------------------------------------------------------------
// Parsing helper
// ---------------------------------------------------------------------------

fn parse_mcp_servers(
    parsed: &JsonValue,
    source: McpSource,
    file_path: &Path,
    project_id: Option<&str>,
    project_name: Option<&str>,
) -> Vec<DiscoveredMcpServer> {
    let obj = match parsed.as_object() {
        Some(o) => o,
        None => return vec![],
    };
    let mcp_servers = match obj.get("mcpServers").and_then(|v| v.as_object()) {
        Some(s) => s,
        None => return vec![],
    };

    let mut result = Vec::new();
    for (name, def) in mcp_servers {
        let d = match def.as_object() {
            Some(o) => o,
            None => continue,
        };

        let mut transport = McpTransport::Unknown;
        let mut command: Option<String> = None;
        let mut args: Option<Vec<String>> = None;
        let mut env: Option<HashMap<String, String>> = None;
        let mut url: Option<String> = None;

        if let Some(u) = d.get("url").and_then(|v| v.as_str()) {
            url = Some(u.to_owned());
            transport = if d.get("transport").and_then(|v| v.as_str()) == Some("sse") {
                McpTransport::Sse
            } else {
                McpTransport::Http
            };
        } else if let Some(cmd) = d.get("command").and_then(|v| v.as_str()) {
            command = Some(cmd.to_owned());
            transport = McpTransport::Stdio;
        }

        if let Some(a) = d.get("args").and_then(|v| v.as_array()) {
            args = Some(
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_owned()))
                    .collect(),
            );
        }
        if let Some(e) = d.get("env").and_then(|v| v.as_object()) {
            let mut map = HashMap::new();
            for (k, v) in e {
                if let Some(s) = v.as_str() {
                    map.insert(k.clone(), s.to_owned());
                }
            }
            env = Some(map);
        }

        result.push(DiscoveredMcpServer {
            name: name.clone(),
            transport,
            command,
            args,
            env,
            url,
            source: source.clone(),
            file_path: file_path.display().to_string(),
            project_id: project_id.map(|s| s.to_owned()),
            project_name: project_name.map(|s| s.to_owned()),
        });
    }
    result
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

static NAME_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();

fn name_re() -> &'static regex::Regex {
    NAME_RE.get_or_init(|| regex::Regex::new(r"(?i)^[a-z0-9_-]+$").unwrap())
}

fn validate_draft(draft: &McpServerDraft) -> Result<(), McpError> {
    if !name_re().is_match(&draft.name) {
        return Err(McpError::InvalidName(draft.name.clone()));
    }
    match draft.transport.as_str() {
        "stdio" => {
            if draft.command.as_deref().map(|s| s.trim()).unwrap_or("").is_empty() {
                return Err(McpError::MissingCommand);
            }
        }
        "http" | "sse" => {
            if draft.url.as_deref().map(|s| s.trim()).unwrap_or("").is_empty() {
                return Err(McpError::MissingUrl(draft.transport.clone()));
            }
        }
        other => return Err(McpError::InvalidTransport(other.to_owned())),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Build the server-def object to write into the JSON
// ---------------------------------------------------------------------------

fn build_server_def(draft: &McpServerDraft) -> Map<String, JsonValue> {
    let mut m = Map::new();
    match draft.transport.as_str() {
        "stdio" => {
            m.insert("command".into(), JsonValue::String(draft.command.clone().unwrap().trim().to_owned()));
            if let Some(args) = &draft.args {
                if !args.is_empty() {
                    m.insert("args".into(), JsonValue::Array(args.iter().map(|a| JsonValue::String(a.clone())).collect()));
                }
            }
            if let Some(env) = &draft.env {
                if !env.is_empty() {
                    let mut env_map = Map::new();
                    for (k, v) in env {
                        env_map.insert(k.clone(), JsonValue::String(v.clone()));
                    }
                    m.insert("env".into(), JsonValue::Object(env_map));
                }
            }
        }
        transport => {
            m.insert("type".into(), JsonValue::String(transport.to_owned()));
            m.insert("url".into(), JsonValue::String(draft.url.clone().unwrap().trim().to_owned()));
        }
    }
    m
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// List all MCP servers from ~/.claude.json and all known project .mcp.json files.
pub fn list_mcp_servers(db: &Db) -> Result<Vec<DiscoveredMcpServer>, McpError> {
    let mut all: Vec<DiscoveredMcpServer> = Vec::new();

    let user_path = user_claude_json_path();
    if let Some(parsed) = read_json_file(&user_path) {
        all.extend(parse_mcp_servers(&parsed, McpSource::User, &user_path, None, None));
    }

    for project in list_projects(db)? {
        let proj_mcp = PathBuf::from(&project.path).join(".mcp.json");
        if let Some(parsed) = read_json_file(&proj_mcp) {
            all.extend(parse_mcp_servers(
                &parsed,
                McpSource::Project,
                &proj_mcp,
                Some(&project.id),
                Some(&project.name),
            ));
        }
    }

    // Sort: user first, then project name, then server name
    all.sort_by(|a, b| {
        match (&a.source, &b.source) {
            (McpSource::User, McpSource::Project) => std::cmp::Ordering::Less,
            (McpSource::Project, McpSource::User) => std::cmp::Ordering::Greater,
            _ => {
                let pn = a.project_name.as_deref().unwrap_or("")
                    .cmp(b.project_name.as_deref().unwrap_or(""));
                if pn != std::cmp::Ordering::Equal { pn } else { a.name.cmp(&b.name) }
            }
        }
    });

    Ok(all)
}

/// Add a new MCP server to the appropriate config file.
pub fn add_mcp_server(db: &Db, draft: McpServerDraft) -> Result<(), McpError> {
    validate_draft(&draft)?;
    let file_path = resolve_file_path(db, &draft.source, draft.project_id.as_deref())?;

    let mut parsed = if draft.source == "project" {
        if let Some(dir) = file_path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        read_and_parse_project_file(&file_path)?
    } else {
        read_and_parse_user_file(&file_path)?
    };

    let servers = parsed
        .entry("mcpServers")
        .or_insert_with(|| JsonValue::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| McpError::NotObject(file_path.display().to_string()))?;

    if servers.contains_key(&draft.name) {
        return Err(McpError::AlreadyExists(draft.name.clone()));
    }

    servers.insert(draft.name.clone(), JsonValue::Object(build_server_def(&draft)));

    let content = serde_json::to_string_pretty(&JsonValue::Object(parsed)).unwrap();
    atomic_write(&file_path, &content)?;
    Ok(())
}

/// Update an existing MCP server (supports rename via draft.name != old_name).
pub fn update_mcp_server(
    file_path: &Path,
    old_name: &str,
    draft: McpServerDraft,
) -> Result<(), McpError> {
    validate_draft(&draft)?;

    let user_path = user_claude_json_path();
    let mut parsed = if file_path == user_path {
        read_and_parse_user_file(file_path)?
    } else {
        read_and_parse_project_file(file_path)?
    };

    let servers = parsed
        .get_mut("mcpServers")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| McpError::NoMcpServers(file_path.display().to_string()))?;

    if !servers.contains_key(old_name) {
        return Err(McpError::NotFound(old_name.to_owned()));
    }

    if draft.name != old_name {
        if servers.contains_key(&draft.name) {
            return Err(McpError::AlreadyExists(draft.name.clone()));
        }
        servers.remove(old_name);
    }
    servers.insert(draft.name.clone(), JsonValue::Object(build_server_def(&draft)));

    let content = serde_json::to_string_pretty(&JsonValue::Object(parsed)).unwrap();
    atomic_write(file_path, &content)?;
    Ok(())
}

/// Delete an MCP server from a config file.
pub fn delete_mcp_server(file_path: &Path, name: &str) -> Result<(), McpError> {
    let user_path = user_claude_json_path();
    let mut parsed = if file_path == user_path {
        read_and_parse_user_file(file_path)?
    } else {
        read_and_parse_project_file(file_path)?
    };

    let servers = parsed
        .get_mut("mcpServers")
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| McpError::NoMcpServers(file_path.display().to_string()))?;

    if !servers.contains_key(name) {
        return Err(McpError::NotFound(name.to_owned()));
    }

    servers.remove(name);

    let content = serde_json::to_string_pretty(&JsonValue::Object(parsed)).unwrap();
    atomic_write(file_path, &content)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn stdio_draft(name: &str, source: &str, project_id: Option<&str>) -> McpServerDraft {
        McpServerDraft {
            name: name.to_owned(),
            transport: "stdio".into(),
            command: Some("my-server".into()),
            args: Some(vec!["--port".into(), "8080".into()]),
            env: None,
            url: None,
            source: source.to_owned(),
            project_id: project_id.map(|s| s.to_owned()),
        }
    }

    fn http_draft(name: &str) -> McpServerDraft {
        McpServerDraft {
            name: name.to_owned(),
            transport: "http".into(),
            command: None,
            args: None,
            env: None,
            url: Some("http://localhost:9000".into()),
            source: "user".into(),
            project_id: None,
        }
    }

    #[test]
    fn validate_invalid_name() {
        let d = McpServerDraft {
            name: "invalid name!".into(),
            transport: "stdio".into(),
            command: Some("cmd".into()),
            args: None,
            env: None,
            url: None,
            source: "user".into(),
            project_id: None,
        };
        assert!(matches!(validate_draft(&d), Err(McpError::InvalidName(_))));
    }

    #[test]
    fn validate_missing_command_for_stdio() {
        let mut d = stdio_draft("valid-name", "user", None);
        d.command = None;
        assert!(matches!(validate_draft(&d), Err(McpError::MissingCommand)));
    }

    #[test]
    fn validate_missing_url_for_http() {
        let mut d = http_draft("my-server");
        d.url = None;
        assert!(matches!(validate_draft(&d), Err(McpError::MissingUrl(_))));
    }

    #[test]
    fn validate_invalid_transport() {
        let d = McpServerDraft {
            name: "ok".into(),
            transport: "grpc".into(),
            command: None,
            args: None,
            env: None,
            url: None,
            source: "user".into(),
            project_id: None,
        };
        assert!(matches!(validate_draft(&d), Err(McpError::InvalidTransport(_))));
    }

    #[test]
    fn add_list_delete_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mcp_path = dir.path().join(".mcp.json");

        // Manually write an initial file and test parse → add → list → delete.
        // We test project-level since that creates if missing.
        // We need a real db with a project pointing to our temp dir.
        let db_dir = tempfile::tempdir().unwrap();
        let db_path = db_dir.path().join("test.sqlite");
        let db = Db::open_at(&db_path).unwrap();

        // Insert a project row directly
        let proj_id = "proj-test-123";
        db.conn().execute(
            "INSERT INTO projects (id, path, name, added_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![proj_id, dir.path().to_str().unwrap(), "TestProject", 0i64],
        ).unwrap();

        let draft = McpServerDraft {
            name: "my-server".into(),
            transport: "stdio".into(),
            command: Some("npx".into()),
            args: Some(vec!["my-pkg".into()]),
            env: None,
            url: None,
            source: "project".into(),
            project_id: Some(proj_id.into()),
        };

        add_mcp_server(&db, draft.clone()).unwrap();

        // .mcp.json should now exist
        assert!(mcp_path.exists());

        // list_mcp_servers should find it
        let servers = list_mcp_servers(&db).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "my-server");
        assert_eq!(servers[0].transport, McpTransport::Stdio);
        assert_eq!(servers[0].command.as_deref(), Some("npx"));

        // Adding duplicate should fail
        let result = add_mcp_server(&db, draft);
        assert!(matches!(result, Err(McpError::AlreadyExists(_))));

        // Delete it
        delete_mcp_server(&mcp_path, "my-server").unwrap();

        // list should now be empty
        let servers = list_mcp_servers(&db).unwrap();
        assert!(servers.is_empty());
    }

    #[test]
    fn update_renames_server() {
        let dir = tempfile::tempdir().unwrap();
        let mcp_path = dir.path().join(".mcp.json");
        std::fs::write(&mcp_path, r#"{"mcpServers":{"old-name":{"command":"cmd"}}}"#).unwrap();

        let draft = McpServerDraft {
            name: "new-name".into(),
            transport: "stdio".into(),
            command: Some("cmd".into()),
            args: None,
            env: None,
            url: None,
            source: "project".into(),
            project_id: None,
        };

        update_mcp_server(&mcp_path, "old-name", draft).unwrap();

        let raw = std::fs::read_to_string(&mcp_path).unwrap();
        let parsed: JsonValue = serde_json::from_str(&raw).unwrap();
        let servers = parsed["mcpServers"].as_object().unwrap();
        assert!(servers.contains_key("new-name"), "rename should have happened");
        assert!(!servers.contains_key("old-name"), "old key should be gone");
    }

    #[test]
    fn delete_nonexistent_errors() {
        let dir = tempfile::tempdir().unwrap();
        let mcp_path = dir.path().join(".mcp.json");
        std::fs::write(&mcp_path, r#"{"mcpServers":{}}"#).unwrap();

        let result = delete_mcp_server(&mcp_path, "ghost");
        assert!(matches!(result, Err(McpError::NotFound(_))));
    }

    #[test]
    fn parse_http_transport() {
        let json: JsonValue = serde_json::from_str(
            r#"{"mcpServers":{"my-api":{"url":"http://localhost:8080"}}}"#
        ).unwrap();
        let servers = parse_mcp_servers(&json, McpSource::User, Path::new("/fake"), None, None);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].transport, McpTransport::Http);
        assert_eq!(servers[0].url.as_deref(), Some("http://localhost:8080"));
    }

    #[test]
    fn parse_sse_transport() {
        let json: JsonValue = serde_json::from_str(
            r#"{"mcpServers":{"sse-srv":{"url":"http://localhost:8080","transport":"sse"}}}"#
        ).unwrap();
        let servers = parse_mcp_servers(&json, McpSource::User, Path::new("/fake"), None, None);
        assert_eq!(servers[0].transport, McpTransport::Sse);
    }
}
