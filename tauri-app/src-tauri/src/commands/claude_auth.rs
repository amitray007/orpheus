// claudeAuth:* commands — auth state read/write + connection test.

use tauri::State;

use crate::claude_auth::{self, ClaudeAuthPatch, ClaudeAuthState, ClaudeAuthTestResult};
use crate::SharedDb;

#[tauri::command]
pub fn claude_auth_get(db: State<SharedDb>) -> Result<ClaudeAuthState, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    claude_auth::get_claude_auth_state(&lock).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn claude_auth_update(
    db: State<SharedDb>,
    patch: ClaudeAuthPatch,
) -> Result<ClaudeAuthState, String> {
    let lock = db.lock().map_err(|e| e.to_string())?;
    claude_auth::update_claude_auth(&lock, patch).map_err(|e| e.to_string())
}

// test_anthropic_connection is async and does network I/O.
// block_in_place allows awaiting inside a blocking closure without blocking the
// async executor thread permanently.
#[tauri::command]
pub async fn claude_auth_test_connection(
    db: State<'_, SharedDb>,
) -> Result<ClaudeAuthTestResult, String> {
    let db_arc = db.inner().clone();
    tokio::task::block_in_place(move || {
        let lock = db_arc.lock().map_err(|e| e.to_string())?;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        Ok(rt.block_on(claude_auth::test_anthropic_connection(&lock)))
    })
}
