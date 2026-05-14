// Context menu stub — defines the data model for native context menus.
// The actual popup call lives in Phase 3 (IPC commands). The renderer
// sends a Vec<MenuItemSpec> via IPC; main process returns the chosen action.

use serde::{Deserialize, Serialize};

/// A single item in a context menu, as specified by the renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MenuItemSpec {
    Separator { divider: bool },
    Action {
        label: String,
        action: String,
        #[serde(default = "default_true")]
        enabled: bool,
    },
}

fn default_true() -> bool {
    true
}

/// Build the ordered list of actions from a spec, filtering out separators.
/// Returns (label, action, enabled) tuples in presentation order.
pub fn build_action_list(items: &[MenuItemSpec]) -> Vec<(&str, &str, bool)> {
    items
        .iter()
        .filter_map(|item| match item {
            MenuItemSpec::Action {
                label,
                action,
                enabled,
            } => Some((label.as_str(), action.as_str(), *enabled)),
            MenuItemSpec::Separator { .. } => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_items() -> Vec<MenuItemSpec> {
        vec![
            MenuItemSpec::Action {
                label: "Copy".into(),
                action: "copy".into(),
                enabled: true,
            },
            MenuItemSpec::Separator { divider: true },
            MenuItemSpec::Action {
                label: "Paste".into(),
                action: "paste".into(),
                enabled: false,
            },
        ]
    }

    #[test]
    fn build_action_list_filters_separators() {
        let items = sample_items();
        let actions = build_action_list(&items);
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0], ("Copy", "copy", true));
        assert_eq!(actions[1], ("Paste", "paste", false));
    }

    #[test]
    fn serde_round_trip() {
        let items = sample_items();
        let json = serde_json::to_string(&items).expect("serialize");
        let back: Vec<MenuItemSpec> = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.len(), items.len());
    }

    #[test]
    fn default_enabled_is_true() {
        let json = r#"[{"label":"Open","action":"open"}]"#;
        let items: Vec<MenuItemSpec> = serde_json::from_str(json).expect("parse");
        match &items[0] {
            MenuItemSpec::Action { enabled, .. } => assert!(*enabled),
            _ => panic!("expected Action"),
        }
    }
}
