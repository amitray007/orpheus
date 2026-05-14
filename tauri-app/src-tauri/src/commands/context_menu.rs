// contextMenu:* commands — native context menu using tauri-plugin-menu.

use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use crate::context_menu::MenuItemSpec;

/// Show a native context menu. Returns the chosen action string, or null if dismissed.
#[tauri::command]
pub async fn context_menu_show(
    app: AppHandle,
    items: Vec<MenuItemSpec>,
) -> Result<Option<String>, String> {
    use tauri::menu::{Menu, MenuItem};

    let actions = crate::context_menu::build_action_list(&items);
    if actions.is_empty() {
        return Ok(None);
    }

    let (tx, rx) = oneshot::channel::<Option<String>>();
    let tx = Arc::new(Mutex::new(Some(tx)));

    let menu = Menu::new(&app).map_err(|e| e.to_string())?;

    for (label, action, enabled) in &actions {
        let label_owned = label.to_owned().to_owned();
        let action_owned = action.to_owned().to_owned();
        let item = MenuItem::with_id(
            &app,
            &action_owned,
            &label_owned,
            *enabled,
            None::<&str>,
        )
        .map_err(|e| e.to_string())?;
        menu.append(&item).map_err(|e| e.to_string())?;
    }

    // Listen for the menu event — fires when an item is clicked.
    let tx3 = tx.clone();
    let _unlisten = app.on_menu_event(move |_app, ev| {
        if let Ok(mut guard) = tx3.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(Some(ev.id().0.clone()));
            }
        }
    });

    let window = app
        .get_webview_window("main")
        .ok_or("no main window")?;

    // popup_menu shows the menu and returns immediately; the result arrives via on_menu_event.
    let window2 = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = window2.popup_menu(&menu);
        })
        .map_err(|e| e.to_string())?;

    // Wait a short time for the event. If the user dismisses without selecting,
    // no event fires — the sender is dropped and rx returns Err, which we map to None.
    tokio::select! {
        result = rx => Ok(result.unwrap_or(None)),
        _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
            // Menu was dismissed without selection
            if let Ok(mut guard) = tx.lock() {
                guard.take(); // drop sender
            }
            Ok(None)
        }
    }
}
