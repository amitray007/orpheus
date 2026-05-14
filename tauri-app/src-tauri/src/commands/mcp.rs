// mcp:* commands — MCP server discovery + CRUD.

use serde::Deserialize;
use tauri::State;

use crate::mcp::{self, DiscoveredMcpServer, McpServerDraft};
use crate::SharedDb;

#[tauri::command]
pub fn mcp_list_servers(db: State<SharedDb>) -> Result<Vec<DiscoveredMcpServer>, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    mcp::list_mcp_servers(&lock).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mcp_add(db: State<SharedDb>, draft: McpServerDraft) -> Result<(), String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    mcp::add_mcp_server(&lock, draft).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
pub struct McpUpdateDraft {
    pub name: String,
    pub transport: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<std::collections::HashMap<String, String>>,
    pub url: Option<String>,
}

#[tauri::command]
pub fn mcp_update(
    file_path: String,
    old_name: String,
    draft: McpUpdateDraft,
) -> Result<(), String> {
    // Reconstruct a minimal McpServerDraft (source/project_id ignored by update_mcp_server).
    let server_draft = McpServerDraft {
        name: draft.name,
        transport: draft.transport,
        command: draft.command,
        args: draft.args,
        env: draft.env,
        url: draft.url,
        source: String::new(),
        project_id: None,
    };
    mcp::update_mcp_server(
        std::path::Path::new(&file_path),
        &old_name,
        server_draft,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mcp_delete(file_path: String, name: String) -> Result<(), String> {
    mcp::delete_mcp_server(std::path::Path::new(&file_path), &name)
        .map_err(|e| e.to_string())
}
