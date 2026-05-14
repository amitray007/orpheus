// claudeAgents:* commands — slash commands and subagents.

use serde::Deserialize;
use tauri::State;

use crate::claude_agents::{
    self, ClaudeSlashCommand, ClaudeSubagent, SlashCommandDraft, SubagentDraft,
};
use crate::SharedDb;

#[tauri::command]
pub fn claude_agents_list_slash_commands(db: State<SharedDb>) -> Result<Vec<ClaudeSlashCommand>, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    Ok(claude_agents::list_slash_commands(&lock))
}

#[tauri::command]
pub fn claude_agents_list_subagents(db: State<SharedDb>) -> Result<Vec<ClaudeSubagent>, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    Ok(claude_agents::list_subagents(&lock))
}

#[tauri::command]
pub fn claude_agents_add_slash_command(
    db: State<SharedDb>,
    draft: SlashCommandDraft,
) -> Result<(), String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    claude_agents::add_slash_command(&lock, draft).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
pub struct SlashCommandUpdateDraft {
    pub description: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    pub argument_hint: Option<String>,
    pub body: String,
}

#[tauri::command]
pub fn claude_agents_update_slash_command(
    file_path: String,
    draft: SlashCommandUpdateDraft,
) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    // update_slash_command validates draft.name == file stem — derive it.
    let name = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let full = SlashCommandDraft {
        name,
        source: String::new(),
        project_id: None,
        description: draft.description,
        allowed_tools: draft.allowed_tools,
        argument_hint: draft.argument_hint,
        body: draft.body,
    };
    claude_agents::update_slash_command(path, full).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn claude_agents_delete_slash_command(file_path: String) -> Result<(), String> {
    claude_agents::delete_slash_command(std::path::Path::new(&file_path))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn claude_agents_add_subagent(
    db: State<SharedDb>,
    draft: SubagentDraft,
) -> Result<(), String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    claude_agents::add_subagent(&lock, draft).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
pub struct SubagentUpdateDraft {
    pub description: Option<String>,
    pub tools: Option<Vec<String>>,
    pub model: Option<String>,
    pub body: String,
}

#[tauri::command]
pub fn claude_agents_update_subagent(
    file_path: String,
    draft: SubagentUpdateDraft,
) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    let name = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let full = SubagentDraft {
        name,
        source: String::new(),
        project_id: None,
        description: draft.description,
        tools: draft.tools,
        model: draft.model,
        body: draft.body,
    };
    claude_agents::update_subagent(path, full).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn claude_agents_delete_subagent(file_path: String) -> Result<(), String> {
    claude_agents::delete_subagent(std::path::Path::new(&file_path))
        .map_err(|e| e.to_string())
}
