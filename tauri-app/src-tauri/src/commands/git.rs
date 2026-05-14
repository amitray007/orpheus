// git:* commands.

use std::path::Path;

use crate::git::{self, GitStatus};

#[tauri::command]
pub fn git_status(cwd: String) -> Option<GitStatus> {
    git::get_git_status(Path::new(&cwd))
}
