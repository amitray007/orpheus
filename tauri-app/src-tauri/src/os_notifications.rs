// OS notifications — mirrors src/main/osNotifications.ts.
// Uses notify-rust for cross-platform native notifications.
// Click-to-focus callback is stubbed (Phase 3 will wire AppHandle::emit).
// Backoff retry logic and suppression logic are preserved as pure functions;
// the timers are spawned as tokio tasks so the caller stays non-blocking.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_rust::{Notification, Timeout};

/// Shell-escape a string for inclusion in an AppleScript double-quoted string.
/// Replaces `\` with `\\` and `"` with `\"`. Newlines are left as `\n` literals.
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Fire a notification via `osascript display notification`. Ad-hoc signed
/// Tauri builds can't request UNUserNotificationCenter permission cleanly,
/// so notify-rust silently no-ops. osascript uses Script Editor's
/// pre-granted notification entitlement and works on every Mac.
#[cfg(target_os = "macos")]
fn show_via_osascript(params: &NotifParams) -> std::io::Result<()> {
    let mut script = format!(
        "display notification \"{}\" with title \"{}\"",
        applescript_escape(&params.body),
        applescript_escape(&params.title),
    );
    if let Some(sub) = &params.subtitle {
        script.push_str(&format!(" subtitle \"{}\"", applescript_escape(sub)));
    }
    if !params.silent {
        script.push_str(" sound name \"default\"");
    }
    let status = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .status()?;
    if !status.success() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("osascript exited with status {}", status),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Which blocking tool (if any) is holding a workspace in attention state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockingTool {
    AskUserQuestion,
    ExitPlanMode,
    /// A permission decision the user must accept/deny.
    Permission,
}

impl BlockingTool {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "AskUserQuestion" => Some(Self::AskUserQuestion),
            "ExitPlanMode" => Some(Self::ExitPlanMode),
            _ => None,
        }
    }
}

/// The notification copy for an attention event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionCopy {
    pub title: String,
    pub body: String,
}

/// Parameters needed to show a notification (all plain data — no AppHandle yet).
#[derive(Debug, Clone)]
pub struct NotifParams {
    pub title: String,
    pub subtitle: Option<String>,
    pub body: String,
    pub silent: bool,
}

// ---------------------------------------------------------------------------
// Pure helpers (tested without touching the OS notification daemon)
// ---------------------------------------------------------------------------

/// Build the copy for an attention notification.
pub fn attention_copy(blocking_tool: Option<&BlockingTool>) -> AttentionCopy {
    match blocking_tool {
        Some(BlockingTool::AskUserQuestion) => AttentionCopy {
            title: "Claude is asking".into(),
            body: "Has a question for you".into(),
        },
        Some(BlockingTool::ExitPlanMode) => AttentionCopy {
            title: "Claude has a plan".into(),
            body: "Waiting for your review before continuing".into(),
        },
        _ => AttentionCopy {
            title: "Claude needs you".into(),
            body: "Waiting on a permission decision".into(),
        },
    }
}

/// Compute body and title for a repeated attention notification.
pub fn attention_params(
    label: &str,
    blocking_tool: Option<&BlockingTool>,
    count: u32,
    max_repeats: u32,
) -> NotifParams {
    let copy = attention_copy(blocking_tool);
    let title = if count == 0 {
        copy.title.clone()
    } else {
        format!("{} (still)", copy.title)
    };
    let body = if count == 0 {
        copy.body.clone()
    } else {
        format!("{} ({} of {})", copy.body, count + 1, max_repeats + 1)
    };
    NotifParams {
        title,
        subtitle: Some(label.to_owned()),
        body,
        silent: false,
    }
}

/// Build the "Claude finished" stop notification params.
pub fn stop_params(label: &str) -> NotifParams {
    NotifParams {
        title: "Claude finished".into(),
        subtitle: Some(label.to_owned()),
        body: "Ready for your next message".into(),
        silent: true,
    }
}

/// Exponential backoff delays in ms, matching the TS ATTENTION_BACKOFF_MS array.
pub const ATTENTION_BACKOFF_MS: [u64; 5] = [30_000, 60_000, 120_000, 240_000, 480_000];

/// Return the delay for the Nth retry attempt (0-indexed), capped at the last slot.
pub fn backoff_delay(attempt: u32) -> Duration {
    let idx = (attempt as usize).min(ATTENTION_BACKOFF_MS.len() - 1);
    Duration::from_millis(ATTENTION_BACKOFF_MS[idx])
}

// ---------------------------------------------------------------------------
// OS-level show (wraps notify-rust)
// ---------------------------------------------------------------------------

/// Fire a native OS notification. On macOS we route via `osascript` because
/// notify-rust + ad-hoc signing silently no-ops (no UNUserNotificationCenter
/// permission grant exists). On other platforms we still use notify-rust.
pub fn show_notification(params: &NotifParams) -> notify_rust::error::Result<()> {
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = show_via_osascript(params) {
            eprintln!("[notifications] osascript failed: {e}; falling back to notify-rust");
        } else {
            return Ok(());
        }
    }

    let mut n = Notification::new();
    n.summary(&params.title).body(&params.body);
    if let Some(sub) = &params.subtitle {
        n.subtitle(sub);
    }
    if !params.silent {
        n.sound_name("default");
    }
    n.timeout(Timeout::Default);
    n.show()?;
    Ok(())
}

/// Fire a test notification (mirrors fireTestNotification in TS).
pub fn fire_test_notification() -> notify_rust::error::Result<()> {
    let params = NotifParams {
        title: "Test notification".into(),
        subtitle: Some("Orpheus".into()),
        body: "If you see this, notifications are working.".into(),
        silent: false,
    };
    show_notification(&params)
}

// ---------------------------------------------------------------------------
// Retry state tracker (mirrors attentionRetries Map in TS)
// ---------------------------------------------------------------------------

/// Holds per-workspace retry count so callers can cancel when the user focuses.
#[derive(Debug, Default)]
pub struct AttentionRetryState {
    inner: HashMap<String, u32>,
}

impl AttentionRetryState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that we have queued retry #`count` for `workspace_id`.
    pub fn set(&mut self, workspace_id: &str, count: u32) {
        self.inner.insert(workspace_id.to_owned(), count);
    }

    /// Cancel any pending retry for `workspace_id`.
    pub fn cancel(&mut self, workspace_id: &str) {
        self.inner.remove(workspace_id);
    }

    /// True if the pending retry count matches `expected_count` (guards stale callbacks).
    pub fn matches(&self, workspace_id: &str, expected_count: u32) -> bool {
        self.inner.get(workspace_id).copied() == Some(expected_count)
    }
}

/// Cancel pending attention retries for a workspace (e.g. user focused it or reset activity).
pub fn cancel_for_workspace(state: &SharedRetryState, workspace_id: &str) {
    if let Ok(mut s) = state.lock() {
        s.cancel(workspace_id);
    }
}

/// Holds the workspace_id currently visible to the user.
/// Notifications for this workspace are suppressed.
/// TODO(phase-4): show_notification and schedule_attention_retries should consult this.
#[derive(Debug, Default)]
pub struct CurrentlyViewed {
    inner: Option<String>,
}

impl CurrentlyViewed {
    pub fn set(&mut self, workspace_id: Option<String>) {
        self.inner = workspace_id;
    }

    pub fn get(&self) -> Option<&str> {
        self.inner.as_deref()
    }
}

pub type SharedCurrentlyViewed = Arc<Mutex<CurrentlyViewed>>;

/// Shared handle to retry state, safe to clone and pass to async tasks.
pub type SharedRetryState = Arc<Mutex<AttentionRetryState>>;

/// Schedule a chain of attention retries using tokio::time::sleep.
/// Each retry checks `retry_state` to verify it's still current before firing.
pub fn schedule_attention_retries(
    workspace_id: String,
    label: String,
    blocking_tool: Option<BlockingTool>,
    start_count: u32,
    max_repeats: u32,
    retry_state: SharedRetryState,
) {
    let tool_arc = Arc::new(blocking_tool);
    tokio::spawn(async move {
        let mut count = start_count;
        while count <= max_repeats {
            tokio::time::sleep(backoff_delay(count - 1)).await;
            // Check if the retry is still current (not cancelled by focus/status change)
            let still_current = {
                let st = retry_state.lock().unwrap();
                st.matches(&workspace_id, count)
            };
            if !still_current {
                break;
            }
            let params = attention_params(&label, tool_arc.as_ref().as_ref(), count, max_repeats);
            let _ = show_notification(&params);
            count += 1;
        }
        // Clean up after the chain finishes
        let mut st = retry_state.lock().unwrap();
        st.cancel(&workspace_id);
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attention_copy_ask_user() {
        let copy = attention_copy(Some(&BlockingTool::AskUserQuestion));
        assert_eq!(copy.title, "Claude is asking");
        assert_eq!(copy.body, "Has a question for you");
    }

    #[test]
    fn attention_copy_exit_plan_mode() {
        let copy = attention_copy(Some(&BlockingTool::ExitPlanMode));
        assert_eq!(copy.title, "Claude has a plan");
    }

    #[test]
    fn attention_copy_permission() {
        let copy = attention_copy(None);
        assert_eq!(copy.title, "Claude needs you");
    }

    #[test]
    fn attention_params_first_fire() {
        let p = attention_params("My Project · Task", Some(&BlockingTool::AskUserQuestion), 0, 3);
        assert_eq!(p.title, "Claude is asking");
        assert_eq!(p.body, "Has a question for you");
        assert_eq!(p.subtitle.as_deref(), Some("My Project · Task"));
    }

    #[test]
    fn attention_params_repeat() {
        let p = attention_params("label", None, 2, 4);
        assert!(p.title.contains("still"), "title should say still: {}", p.title);
        assert!(p.body.contains("3 of 5"), "body should have repeat count: {}", p.body);
    }

    #[test]
    fn stop_params_structure() {
        let p = stop_params("Proj · WS");
        assert_eq!(p.title, "Claude finished");
        assert!(p.silent);
        assert_eq!(p.subtitle.as_deref(), Some("Proj · WS"));
    }

    #[test]
    fn backoff_delay_capped() {
        assert_eq!(backoff_delay(0), Duration::from_millis(ATTENTION_BACKOFF_MS[0]));
        assert_eq!(backoff_delay(4), Duration::from_millis(ATTENTION_BACKOFF_MS[4]));
        // Beyond the end — stays at the last slot
        assert_eq!(backoff_delay(100), Duration::from_millis(ATTENTION_BACKOFF_MS[4]));
    }

    #[test]
    fn blocking_tool_from_str() {
        assert_eq!(BlockingTool::from_str("AskUserQuestion"), Some(BlockingTool::AskUserQuestion));
        assert_eq!(BlockingTool::from_str("ExitPlanMode"), Some(BlockingTool::ExitPlanMode));
        assert_eq!(BlockingTool::from_str("Other"), None);
    }

    #[test]
    fn retry_state_cancel_clears() {
        let mut state = AttentionRetryState::new();
        state.set("ws1", 1);
        assert!(state.matches("ws1", 1));
        state.cancel("ws1");
        assert!(!state.matches("ws1", 1));
    }

    /// Actual OS notification show — run manually only.
    #[test]
    #[ignore]
    fn show_test_notification_live() {
        fire_test_notification().expect("notification send failed");
    }
}
