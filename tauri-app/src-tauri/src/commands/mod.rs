// Command module index. Re-exports all sub-modules so lib.rs can reference them
// as commands::terminal::terminal_mount, commands::projects::projects_list, etc.

pub mod app;
pub mod claude_agents;
pub mod claude_auth;
pub mod claude_hooks;
pub mod claude_project_settings;
pub mod claude_settings;
pub mod claude_workspace_settings;
pub mod config;
pub mod context_menu;
pub mod doctor;
pub mod events;
pub mod git;
pub mod mcp;
pub mod os_notifications;
pub mod projects;
pub mod sessions;
pub mod terminal;
pub mod ui_state;
pub mod window;
pub mod workspaces;
