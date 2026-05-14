// notifications:* commands.

use crate::os_notifications;

#[tauri::command]
pub fn notifications_test() -> Result<(), String> {
    os_notifications::fire_test_notification().map_err(|e| e.to_string())
}
