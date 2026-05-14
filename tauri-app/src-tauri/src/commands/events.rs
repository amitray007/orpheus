// Shared mutable state injected as Tauri-managed resources.
// The socket server and title callback emit events into the renderer via AppHandle.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

use crate::claude_settings::ClaudeLaunch;
use crate::db::Db;

/// In-memory map of workspaceId → most recent cleaned terminal title.
pub type TitleMap = Arc<Mutex<HashMap<String, String>>>;

/// Set of workspaceIds with unsaved launch-config drift (dirty).
pub type DirtySet = Arc<Mutex<HashSet<String>>>;

/// Map of workspaceId → the ClaudeLaunch captured at mount time.
/// Used to recompute dirty state when settings change.
pub type MountSnapshots = Arc<Mutex<HashMap<String, ClaudeLaunch>>>;

/// Create default-initialized instances for use in app.manage().
pub fn new_title_map() -> TitleMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn new_dirty_set() -> DirtySet {
    Arc::new(Mutex::new(HashSet::new()))
}

pub fn new_mount_snapshots() -> MountSnapshots {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Recompute dirty for every workspace that has a mount snapshot.
/// Fires workspace:dirtyChanged for any workspace whose dirty state changes.
pub fn recompute_dirty_for_all_mounted(
    db: &Db,
    app: &AppHandle,
    snapshots: &MountSnapshots,
    dirty_set: &DirtySet,
) {
    let snap_map = match snapshots.lock() {
        Ok(m) => m,
        Err(_) => return,
    };
    for (workspace_id, snapshot_launch) in snap_map.iter() {
        // Fetch workspace-specific overrides to compose the current effective launch.
        let project_ovr = crate::claude_project_settings::get_project_overrides_by_workspace(db, workspace_id).ok().flatten();
        let ws_ovr = crate::claude_workspace_settings::get_workspace_overrides(db, workspace_id).ok().flatten();
        let current_launch = match crate::claude_settings::compose_claude_launch(
            db,
            project_ovr.as_ref(),
            ws_ovr.as_ref(),
            None,
        ) {
            Ok(l) => l,
            Err(_) => continue,
        };

        let is_dirty = current_launch.flags != snapshot_launch.flags
            || current_launch.settings_json != snapshot_launch.settings_json
            || current_launch.env != snapshot_launch.env;

        let mut ds = match dirty_set.lock() {
            Ok(s) => s,
            Err(_) => continue,
        };
        let was_dirty = ds.contains(workspace_id);
        if is_dirty == was_dirty {
            continue;
        }
        if is_dirty {
            ds.insert(workspace_id.clone());
        } else {
            ds.remove(workspace_id);
        }
        drop(ds);
        let _ = app.emit(
            "workspace:dirtyChanged",
            serde_json::json!({ "workspaceId": workspace_id, "dirty": is_dirty }),
        );
    }
}
