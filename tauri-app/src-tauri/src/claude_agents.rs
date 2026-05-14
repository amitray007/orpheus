// Slash-command and subagent file management.
// Mirrors src/main/claudeAgents.ts. Reads ~/.claude/commands|agents/ and per-project equivalents.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};

use crate::db::Db;
use crate::projects::list_projects;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ClaudeAgentsError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("project not found: {0}")]
    ProjectNotFound(String),

    #[error("invalid name \"{0}\": use only lowercase letters, digits, underscores, hyphens")]
    InvalidName(String),

    #[error("body cannot be empty")]
    EmptyBody,

    #[error("cannot rename via update — delete and re-create")]
    RenameNotSupported,

    #[error("file not found: {0}")]
    FileNotFound(String),

    #[error("already exists: {0}")]
    AlreadyExists(String),

    #[error("tempfile persist error: {0}")]
    Persist(String),
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSlashCommand {
    pub name: String,
    pub path: String,
    pub source: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub description: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    pub argument_hint: Option<String>,
    pub frontmatter: Map<String, JsonValue>,
    pub body_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSubagent {
    pub name: String,
    pub path: String,
    pub source: String,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub description: Option<String>,
    pub tools: Option<Vec<String>>,
    pub model: Option<String>,
    pub frontmatter: Map<String, JsonValue>,
    pub body_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandDraft {
    pub name: String,
    pub source: String,
    pub project_id: Option<String>,
    pub description: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    pub argument_hint: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentDraft {
    pub name: String,
    pub source: String,
    pub project_id: Option<String>,
    pub description: Option<String>,
    pub tools: Option<Vec<String>>,
    pub model: Option<String>,
    pub body: String,
}

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

static SLUG_RE: once_cell::sync::Lazy<regex::Regex> =
    once_cell::sync::Lazy::new(|| regex::Regex::new(r"^[a-z0-9_-]+$").unwrap());

fn validate_name(name: &str) -> Result<(), ClaudeAgentsError> {
    if !SLUG_RE.is_match(name) {
        return Err(ClaudeAgentsError::InvalidName(name.to_owned()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Frontmatter parsing (mirrors TS parseFrontmatter)
// Handles: scalar strings, inline flow sequences [a, b], block sequences (  - item)
// ---------------------------------------------------------------------------

fn fm_list(items: Vec<String>) -> JsonValue {
    JsonValue::Array(items.into_iter().map(JsonValue::String).collect())
}

fn parse_frontmatter(content: &str) -> Map<String, JsonValue> {
    let mut result = Map::new();
    let lines: Vec<&str> = content.lines().collect();

    if lines.first().map(|l| l.trim()) != Some("---") {
        return result;
    }

    let mut i = 1usize;
    while i < lines.len() && lines[i].trim() != "---" {
        let line = lines[i];
        let colon_idx = match line.find(':') {
            Some(idx) => idx,
            None => {
                i += 1;
                continue;
            }
        };

        let key = line[..colon_idx].trim().to_owned();
        let rest = &line[colon_idx + 1..];

        // Block sequence: next lines start with "  - "
        if rest.trim().is_empty() {
            let mut items = Vec::new();
            let mut j = i + 1;
            while j < lines.len() {
                if let Some(stripped) = lines[j].strip_prefix("  - ") {
                    items.push(stripped.trim().to_owned());
                    j += 1;
                } else {
                    break;
                }
            }
            if !items.is_empty() {
                result.insert(key, fm_list(items));
                i = j;
                continue;
            }
        }

        let value = rest.trim();

        // Inline flow sequence: [a, b, c]
        if value.starts_with('[') && value.ends_with(']') {
            let inner = &value[1..value.len() - 1];
            let items: Vec<String> = inner
                .split(',')
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .collect();
            result.insert(key, fm_list(items));
            i += 1;
            continue;
        }

        // Scalar — strip surrounding quotes if present
        let scalar = if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            value[1..value.len() - 1].to_owned()
        } else {
            value.to_owned()
        };
        result.insert(key, JsonValue::String(scalar));
        i += 1;
    }

    result
}

// ---------------------------------------------------------------------------
// Frontmatter serialization (mirrors TS serializeFrontmatter)
// ---------------------------------------------------------------------------

fn serialize_frontmatter(fm: &Map<String, JsonValue>) -> String {
    let mut lines = Vec::new();
    for (key, value) in fm {
        match value {
            JsonValue::Array(arr) => {
                if arr.is_empty() {
                    continue;
                }
                let items: Vec<&str> = arr
                    .iter()
                    .filter_map(|v| v.as_str())
                    .collect();
                if items.len() <= 5 {
                    lines.push(format!("{}: [{}]", key, items.join(", ")));
                } else {
                    lines.push(format!("{}:", key));
                    for item in items {
                        lines.push(format!("  - {}", item));
                    }
                }
            }
            JsonValue::String(s) => {
                if s.is_empty() {
                    continue;
                }
                let needs_quotes = s.contains(':') || s.contains('#') || s.starts_with(' ');
                if needs_quotes {
                    lines.push(format!("{}: \"{}\"", key, s.replace('"', "\\\"")));
                } else {
                    lines.push(format!("{}: {}", key, s));
                }
            }
            _ => {}
        }
    }
    lines.join("\n")
}

fn build_md_file(fm: &Map<String, JsonValue>, body: &str) -> String {
    let fm_str = serialize_frontmatter(fm);
    if !fm_str.is_empty() {
        format!("---\n{}\n---\n{}\n", fm_str, body)
    } else {
        format!("{}\n", body)
    }
}

// ---------------------------------------------------------------------------
// Parsed file result
// ---------------------------------------------------------------------------

pub struct ParsedFile {
    pub frontmatter: Map<String, JsonValue>,
    pub body_preview: String,
}

/// Parse frontmatter and extract up to 600-char body preview from a .md file.
pub fn parse_file(path: &Path) -> ParsedFile {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return ParsedFile { frontmatter: Map::new(), body_preview: String::new() },
    };

    let frontmatter = parse_frontmatter(&content);

    // Body = everything after the closing --- line
    let lines: Vec<&str> = content.lines().collect();
    let mut body_preview = String::new();
    if lines.first().map(|l| l.trim()) == Some("---") {
        let closing = lines[1..].iter().position(|l| l.trim() == "---");
        if let Some(rel_idx) = closing {
            let closing_abs = rel_idx + 1;
            let raw = lines[closing_abs + 1..].join("\n").trim().to_owned();
            if raw.len() > 600 {
                body_preview = format!("{}\n\u{2026}", &raw[..600]);
            } else {
                body_preview = raw;
            }
        }
    }

    ParsedFile { frontmatter, body_preview }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

fn atomic_write(path: &Path, content: &str) -> Result<(), ClaudeAgentsError> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(content.as_bytes())?;
    tmp.persist(path)
        .map_err(|e| ClaudeAgentsError::Persist(e.to_string()))?;
    Ok(())
}

fn list_md_files(dir: &Path) -> Vec<PathBuf> {
    if !dir.exists() {
        return vec![];
    }
    let mut files: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name();
                let n = name.to_string_lossy();
                e.file_type().map(|t| t.is_file()).unwrap_or(false)
                    && n.ends_with(".md")
                    && !n.starts_with('.')
            })
            .map(|e| e.path())
            .collect(),
        Err(_) => vec![],
    };
    files.sort_by(|a, b| {
        a.file_name()
            .unwrap_or_default()
            .cmp(b.file_name().unwrap_or_default())
    });
    files
}

fn home_dir() -> PathBuf {
    directories::UserDirs::new()
        .map(|u| u.home_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn string_or_none(v: Option<&JsonValue>) -> Option<String> {
    v.and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_owned())
}

fn strings_or_none(v: Option<&JsonValue>) -> Option<Vec<String>> {
    match v {
        Some(JsonValue::Array(arr)) => {
            let items: Vec<String> = arr
                .iter()
                .filter_map(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_owned())
                .collect();
            if items.is_empty() { None } else { Some(items) }
        }
        Some(JsonValue::String(s)) if !s.is_empty() => Some(vec![s.clone()]),
        _ => None,
    }
}

fn resolve_dir(source: &str, project_id: Option<&str>, subdir: &str, db: &Db)
    -> Result<PathBuf, ClaudeAgentsError>
{
    if source == "user" {
        return Ok(home_dir().join(".claude").join(subdir));
    }
    let pid = project_id
        .ok_or_else(|| ClaudeAgentsError::ProjectNotFound("(none)".into()))?;
    let projects = list_projects(db).unwrap_or_default();
    let project = projects
        .iter()
        .find(|p| p.id == pid)
        .ok_or_else(|| ClaudeAgentsError::ProjectNotFound(pid.to_owned()))?;
    Ok(PathBuf::from(&project.path).join(".claude").join(subdir))
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

/// List all slash commands from user and project directories, sorted user-first then by name.
pub fn list_slash_commands(db: &Db) -> Vec<ClaudeSlashCommand> {
    let mut all: Vec<ClaudeSlashCommand> = Vec::new();

    let user_dir = home_dir().join(".claude").join("commands");
    for path in list_md_files(&user_dir) {
        let pf = parse_file(&path);
        let base = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name = string_or_none(pf.frontmatter.get("name")).unwrap_or(base);
        all.push(ClaudeSlashCommand {
            name,
            path: path.display().to_string(),
            source: "user".into(),
            project_id: None,
            project_name: None,
            description: string_or_none(pf.frontmatter.get("description")),
            allowed_tools: strings_or_none(pf.frontmatter.get("allowed-tools")),
            argument_hint: string_or_none(pf.frontmatter.get("argument-hint")),
            frontmatter: pf.frontmatter,
            body_preview: pf.body_preview,
        });
    }

    for project in list_projects(db).unwrap_or_default() {
        let proj_dir = PathBuf::from(&project.path).join(".claude").join("commands");
        for path in list_md_files(&proj_dir) {
            let pf = parse_file(&path);
            let base = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let name = string_or_none(pf.frontmatter.get("name")).unwrap_or(base);
            all.push(ClaudeSlashCommand {
                name,
                path: path.display().to_string(),
                source: "project".into(),
                project_id: Some(project.id.clone()),
                project_name: Some(project.name.clone()),
                description: string_or_none(pf.frontmatter.get("description")),
                allowed_tools: strings_or_none(pf.frontmatter.get("allowed-tools")),
                argument_hint: string_or_none(pf.frontmatter.get("argument-hint")),
                frontmatter: pf.frontmatter,
                body_preview: pf.body_preview,
            });
        }
    }

    all.sort_by(|a, b| {
        if a.source != b.source {
            return if a.source == "user" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        if a.source == "project" {
            let pn = a
                .project_name
                .as_deref()
                .unwrap_or("")
                .cmp(b.project_name.as_deref().unwrap_or(""));
            if pn != std::cmp::Ordering::Equal {
                return pn;
            }
        }
        a.name.cmp(&b.name)
    });

    all
}

pub fn add_slash_command(db: &Db, draft: SlashCommandDraft) -> Result<(), ClaudeAgentsError> {
    validate_name(&draft.name)?;
    if draft.body.trim().is_empty() {
        return Err(ClaudeAgentsError::EmptyBody);
    }
    let dir = resolve_dir(&draft.source, draft.project_id.as_deref(), "commands", db)?;
    let file_path = dir.join(format!("{}.md", draft.name));
    if file_path.exists() {
        return Err(ClaudeAgentsError::AlreadyExists(draft.name));
    }
    let mut fm: Map<String, JsonValue> = Map::new();
    if let Some(d) = draft.description.filter(|s| !s.is_empty()) {
        fm.insert("description".into(), JsonValue::String(d));
    }
    if let Some(tools) = draft.allowed_tools.filter(|v| !v.is_empty()) {
        fm.insert(
            "allowed-tools".into(),
            JsonValue::Array(tools.into_iter().map(JsonValue::String).collect()),
        );
    }
    if let Some(hint) = draft.argument_hint.filter(|s| !s.is_empty()) {
        fm.insert("argument-hint".into(), JsonValue::String(hint));
    }
    let content = build_md_file(&fm, &draft.body);
    atomic_write(&file_path, &content)
}

pub fn update_slash_command(
    file_path: &Path,
    draft: SlashCommandDraft,
) -> Result<(), ClaudeAgentsError> {
    validate_name(&draft.name)?;
    if draft.body.trim().is_empty() {
        return Err(ClaudeAgentsError::EmptyBody);
    }
    let existing_base = file_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if draft.name != existing_base {
        return Err(ClaudeAgentsError::RenameNotSupported);
    }
    if !file_path.exists() {
        return Err(ClaudeAgentsError::FileNotFound(
            file_path.display().to_string(),
        ));
    }
    let mut fm: Map<String, JsonValue> = Map::new();
    if let Some(d) = draft.description.filter(|s| !s.is_empty()) {
        fm.insert("description".into(), JsonValue::String(d));
    }
    if let Some(tools) = draft.allowed_tools.filter(|v| !v.is_empty()) {
        fm.insert(
            "allowed-tools".into(),
            JsonValue::Array(tools.into_iter().map(JsonValue::String).collect()),
        );
    }
    if let Some(hint) = draft.argument_hint.filter(|s| !s.is_empty()) {
        fm.insert("argument-hint".into(), JsonValue::String(hint));
    }
    let content = build_md_file(&fm, &draft.body);
    atomic_write(file_path, &content)
}

pub fn delete_slash_command(file_path: &Path) -> Result<(), ClaudeAgentsError> {
    if !file_path.exists() {
        return Err(ClaudeAgentsError::FileNotFound(
            file_path.display().to_string(),
        ));
    }
    Ok(std::fs::remove_file(file_path)?)
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

/// List all subagents from user and project directories, sorted user-first then by name.
pub fn list_subagents(db: &Db) -> Vec<ClaudeSubagent> {
    let mut all: Vec<ClaudeSubagent> = Vec::new();

    let user_dir = home_dir().join(".claude").join("agents");
    for path in list_md_files(&user_dir) {
        let pf = parse_file(&path);
        let base = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name = string_or_none(pf.frontmatter.get("name")).unwrap_or(base);
        all.push(ClaudeSubagent {
            name,
            path: path.display().to_string(),
            source: "user".into(),
            project_id: None,
            project_name: None,
            description: string_or_none(pf.frontmatter.get("description")),
            tools: strings_or_none(pf.frontmatter.get("tools")),
            model: string_or_none(pf.frontmatter.get("model")),
            frontmatter: pf.frontmatter,
            body_preview: pf.body_preview,
        });
    }

    for project in list_projects(db).unwrap_or_default() {
        let proj_dir = PathBuf::from(&project.path).join(".claude").join("agents");
        for path in list_md_files(&proj_dir) {
            let pf = parse_file(&path);
            let base = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let name = string_or_none(pf.frontmatter.get("name")).unwrap_or(base);
            all.push(ClaudeSubagent {
                name,
                path: path.display().to_string(),
                source: "project".into(),
                project_id: Some(project.id.clone()),
                project_name: Some(project.name.clone()),
                description: string_or_none(pf.frontmatter.get("description")),
                tools: strings_or_none(pf.frontmatter.get("tools")),
                model: string_or_none(pf.frontmatter.get("model")),
                frontmatter: pf.frontmatter,
                body_preview: pf.body_preview,
            });
        }
    }

    all.sort_by(|a, b| {
        if a.source != b.source {
            return if a.source == "user" {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        if a.source == "project" {
            let pn = a
                .project_name
                .as_deref()
                .unwrap_or("")
                .cmp(b.project_name.as_deref().unwrap_or(""));
            if pn != std::cmp::Ordering::Equal {
                return pn;
            }
        }
        a.name.cmp(&b.name)
    });

    all
}

pub fn add_subagent(db: &Db, draft: SubagentDraft) -> Result<(), ClaudeAgentsError> {
    validate_name(&draft.name)?;
    if draft.body.trim().is_empty() {
        return Err(ClaudeAgentsError::EmptyBody);
    }
    let dir = resolve_dir(&draft.source, draft.project_id.as_deref(), "agents", db)?;
    let file_path = dir.join(format!("{}.md", draft.name));
    if file_path.exists() {
        return Err(ClaudeAgentsError::AlreadyExists(draft.name));
    }
    let mut fm: Map<String, JsonValue> = Map::new();
    if let Some(d) = draft.description.filter(|s| !s.is_empty()) {
        fm.insert("description".into(), JsonValue::String(d));
    }
    if let Some(tools) = draft.tools.filter(|v| !v.is_empty()) {
        fm.insert(
            "tools".into(),
            JsonValue::Array(tools.into_iter().map(JsonValue::String).collect()),
        );
    }
    if let Some(m) = draft.model.filter(|s| !s.is_empty()) {
        fm.insert("model".into(), JsonValue::String(m));
    }
    let content = build_md_file(&fm, &draft.body);
    atomic_write(&file_path, &content)
}

pub fn update_subagent(
    file_path: &Path,
    draft: SubagentDraft,
) -> Result<(), ClaudeAgentsError> {
    validate_name(&draft.name)?;
    if draft.body.trim().is_empty() {
        return Err(ClaudeAgentsError::EmptyBody);
    }
    let existing_base = file_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if draft.name != existing_base {
        return Err(ClaudeAgentsError::RenameNotSupported);
    }
    if !file_path.exists() {
        return Err(ClaudeAgentsError::FileNotFound(
            file_path.display().to_string(),
        ));
    }
    let mut fm: Map<String, JsonValue> = Map::new();
    if let Some(d) = draft.description.filter(|s| !s.is_empty()) {
        fm.insert("description".into(), JsonValue::String(d));
    }
    if let Some(tools) = draft.tools.filter(|v| !v.is_empty()) {
        fm.insert(
            "tools".into(),
            JsonValue::Array(tools.into_iter().map(JsonValue::String).collect()),
        );
    }
    if let Some(m) = draft.model.filter(|s| !s.is_empty()) {
        fm.insert("model".into(), JsonValue::String(m));
    }
    let content = build_md_file(&fm, &draft.body);
    atomic_write(file_path, &content)
}

pub fn delete_subagent(file_path: &Path) -> Result<(), ClaudeAgentsError> {
    if !file_path.exists() {
        return Err(ClaudeAgentsError::FileNotFound(
            file_path.display().to_string(),
        ));
    }
    Ok(std::fs::remove_file(file_path)?)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn fixture_md(frontmatter: &str, body: &str) -> String {
        format!("---\n{}\n---\n{}\n", frontmatter, body)
    }

    fn write_file(dir: &Path, name: &str, content: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, content).expect("write");
        path
    }

    #[test]
    fn parse_file_scalar_frontmatter() {
        let dir = tempfile::tempdir().expect("tempdir");
        let content = fixture_md(
            "name: my-cmd\ndescription: Does something useful",
            "Do the thing.",
        );
        let path = write_file(dir.path(), "my-cmd.md", &content);
        let pf = parse_file(&path);
        assert_eq!(
            pf.frontmatter.get("name").and_then(|v| v.as_str()),
            Some("my-cmd")
        );
        assert_eq!(
            pf.frontmatter
                .get("description")
                .and_then(|v| v.as_str()),
            Some("Does something useful")
        );
        assert_eq!(pf.body_preview, "Do the thing.");
    }

    #[test]
    fn parse_file_inline_array_frontmatter() {
        let dir = tempfile::tempdir().expect("tempdir");
        let content = fixture_md("allowed-tools: [Bash, Read, Edit]", "body");
        let path = write_file(dir.path(), "cmd.md", &content);
        let pf = parse_file(&path);
        let tools = strings_or_none(pf.frontmatter.get("allowed-tools")).expect("tools");
        assert_eq!(tools, vec!["Bash", "Read", "Edit"]);
    }

    #[test]
    fn parse_file_block_sequence_frontmatter() {
        let dir = tempfile::tempdir().expect("tempdir");
        let content = "---\ntools:\n  - Bash\n  - Read\n---\nbody\n";
        let path = write_file(dir.path(), "agent.md", content);
        let pf = parse_file(&path);
        let tools = strings_or_none(pf.frontmatter.get("tools")).expect("tools");
        assert_eq!(tools, vec!["Bash", "Read"]);
    }

    #[test]
    fn parse_file_body_preview_truncates_at_600() {
        let dir = tempfile::tempdir().expect("tempdir");
        let long_body = "x".repeat(700);
        let content = fixture_md("name: long", &long_body);
        let path = write_file(dir.path(), "long.md", &content);
        let pf = parse_file(&path);
        assert_eq!(pf.body_preview.len(), 600 + "\n\u{2026}".len());
        assert!(pf.body_preview.ends_with('\u{2026}'));
    }

    #[test]
    fn parse_file_no_frontmatter() {
        let dir = tempfile::tempdir().expect("tempdir");
        let content = "Just a plain body.\n";
        let path = write_file(dir.path(), "plain.md", content);
        let pf = parse_file(&path);
        assert!(pf.frontmatter.is_empty());
        assert_eq!(pf.body_preview, "");
    }

    #[test]
    fn list_md_files_sorted_alpha() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in &["beta.md", "alpha.md", "gamma.md"] {
            write_file(dir.path(), name, "");
        }
        let files = list_md_files(dir.path());
        let names: Vec<_> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["alpha.md", "beta.md", "gamma.md"]);
    }

    #[test]
    fn list_md_files_ignores_dotfiles() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_file(dir.path(), ".hidden.md", "");
        write_file(dir.path(), "visible.md", "");
        let files = list_md_files(dir.path());
        assert_eq!(files.len(), 1);
        assert!(files[0].file_name().unwrap().to_string_lossy() == "visible.md");
    }

    #[test]
    fn build_md_file_with_frontmatter() {
        let mut fm: Map<String, JsonValue> = Map::new();
        fm.insert("description".into(), JsonValue::String("A command".into()));
        let out = build_md_file(&fm, "Do the thing.");
        assert!(out.starts_with("---\n"));
        assert!(out.contains("description: A command"));
        assert!(out.contains("---\nDo the thing."));
    }

    #[test]
    fn build_md_file_without_frontmatter() {
        let fm: Map<String, JsonValue> = Map::new();
        let out = build_md_file(&fm, "body text");
        assert_eq!(out, "body text\n");
    }

    #[test]
    fn validate_name_accepts_valid_slugs() {
        for name in &["foo", "bar-baz", "my_cmd", "cmd123", "a-b-c"] {
            validate_name(name).expect(name);
        }
    }

    #[test]
    fn validate_name_rejects_invalid() {
        for name in &["Foo", "bar baz", "cmd!", "A-B", ""] {
            assert!(validate_name(name).is_err(), "should reject: {}", name);
        }
    }

    #[test]
    fn serialize_inline_array_short() {
        let mut fm: Map<String, JsonValue> = Map::new();
        fm.insert(
            "tools".into(),
            JsonValue::Array(vec![
                JsonValue::String("Bash".into()),
                JsonValue::String("Read".into()),
            ]),
        );
        let out = serialize_frontmatter(&fm);
        assert_eq!(out, "tools: [Bash, Read]");
    }

    #[test]
    fn serialize_block_array_long() {
        let mut fm: Map<String, JsonValue> = Map::new();
        fm.insert(
            "tools".into(),
            JsonValue::Array(
                (0..6)
                    .map(|i| JsonValue::String(format!("tool{}", i)))
                    .collect(),
            ),
        );
        let out = serialize_frontmatter(&fm);
        assert!(out.starts_with("tools:"));
        assert!(out.contains("  - tool0"));
    }
}
