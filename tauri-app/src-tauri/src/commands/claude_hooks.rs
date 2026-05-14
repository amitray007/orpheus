// claudeHooks:* commands — hook list/add/update/delete.

use serde::Deserialize;
use tauri::State;

use crate::claude_hooks::{self, ClaudeHookEntry, NewHook};
use crate::SharedDb;

#[tauri::command]
pub fn claude_hooks_list(db: State<SharedDb>) -> Result<Vec<ClaudeHookEntry>, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    claude_hooks::list_hooks(&lock).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn claude_hooks_open_file(file_path: String) -> Result<(), String> {
    // Open the file in the default editor via the shell open command.
    // Mirrors TS shell.openPath(filePath).
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Linux / Windows fallback
        opener::open(&file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn claude_hooks_add(db: State<SharedDb>, draft: NewHook) -> Result<(), String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    claude_hooks::add_hook(&lock, draft).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
pub struct HookDraftUpdate {
    pub event: String,
    pub matcher: Option<String>,
    #[serde(rename = "type")]
    pub hook_type: String,
    pub command: String,
}

#[tauri::command]
pub fn claude_hooks_update(
    file_path: String,
    event: String,
    matcher_entry_idx: usize,
    hook_idx: usize,
    draft: HookDraftUpdate,
) -> Result<(), String> {
    claude_hooks::update_hook(
        std::path::Path::new(&file_path),
        &event,
        matcher_entry_idx,
        hook_idx,
        &draft.hook_type,
        &draft.command,
        draft.matcher.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn claude_hooks_delete(
    file_path: String,
    event: String,
    matcher_entry_idx: usize,
    hook_idx: usize,
) -> Result<(), String> {
    claude_hooks::delete_hook(
        std::path::Path::new(&file_path),
        &event,
        matcher_entry_idx,
        hook_idx,
    )
    .map_err(|e| e.to_string())
}
