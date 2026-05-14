// Shared mutable state injected as Tauri-managed resources.
// The socket server and title callback emit events into the renderer via AppHandle.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// In-memory map of workspaceId → most recent cleaned terminal title.
pub type TitleMap = Arc<Mutex<HashMap<String, String>>>;

/// Set of workspaceIds with unsaved launch-config drift (dirty).
pub type DirtySet = Arc<Mutex<HashSet<String>>>;

/// Create default-initialized instances for use in app.manage().
pub fn new_title_map() -> TitleMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn new_dirty_set() -> DirtySet {
    Arc::new(Mutex::new(HashSet::new()))
}
