// doctor:* commands — checks whether the claude CLI is installed.

use std::process::Command;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingProject {
    pub encoded_name: String,
    pub path: String,
    pub name: String,
    pub session_count: usize,
    pub last_activity: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorResult {
    pub claude_installed: bool,
    pub claude_version: Option<String>,
    pub claude_path: Option<String>,
    pub existing_projects: Vec<ExistingProject>,
}

fn user_shell_path() -> String {
    let shell = match std::env::var("SHELL") {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    let out = Command::new(&shell)
        .args(["-ilc", "printf \"%s\" \"$PATH\""])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout).trim().to_owned()
        }
        _ => String::new(),
    }
}

fn check_claude() -> (bool, Option<String>, Option<String>) {
    let user_path = user_shell_path();
    let path_val = if user_path.is_empty() {
        std::env::var("PATH").unwrap_or_default()
    } else {
        user_path
    };

    let which_out = Command::new("which")
        .arg("claude")
        .env("PATH", &path_val)
        .output();

    let claude_path = match which_out {
        Ok(o) if o.status.success() => {
            let p = String::from_utf8_lossy(&o.stdout).trim().to_owned();
            if p.is_empty() { return (false, None, None); }
            p
        }
        _ => return (false, None, None),
    };

    let version_out = Command::new("claude")
        .arg("--version")
        .env("PATH", &path_val)
        .output();

    let version = version_out.ok().and_then(|o| {
        let text = String::from_utf8_lossy(&o.stdout).into_owned();
        // Extract semver e.g. "1.2.3"
        text.split_whitespace()
            .find(|w| w.contains('.') && w.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false))
            .map(|s| s.to_owned())
    });

    (true, version, Some(claude_path))
}

fn read_existing_projects() -> Vec<ExistingProject> {
    let home = match directories::UserDirs::new() {
        Some(u) => u.home_dir().to_path_buf(),
        None => return vec![],
    };
    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.exists() {
        return vec![];
    }

    let entries = match std::fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(_) => return vec![],
    };

    let mut projects: Vec<ExistingProject> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| {
            let encoded_name = e.file_name().to_string_lossy().into_owned();
            let path = encoded_name.replace('-', "/");
            let name = std::path::Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());

            let dir_path = e.path();
            let jsonl_files: Vec<_> = std::fs::read_dir(&dir_path)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(|f| f.ok())
                .filter(|f| f.file_name().to_string_lossy().ends_with(".jsonl"))
                .collect();

            let session_count = jsonl_files.len();
            let last_activity = jsonl_files
                .iter()
                .filter_map(|f| f.metadata().ok()?.modified().ok())
                .filter_map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH).ok()
                        .map(|d| d.as_millis() as i64)
                })
                .max();

            ExistingProject {
                encoded_name,
                path,
                name,
                session_count,
                last_activity,
            }
        })
        .collect();

    projects.sort_by(|a, b| match (a.last_activity, b.last_activity) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, _) => std::cmp::Ordering::Greater,
        (_, None) => std::cmp::Ordering::Less,
        (Some(at), Some(bt)) => bt.cmp(&at),
    });

    projects
}

#[tauri::command]
pub fn doctor_check() -> DoctorResult {
    let (claude_installed, claude_version, claude_path) = check_claude();
    DoctorResult {
        claude_installed,
        claude_version,
        claude_path,
        existing_projects: read_existing_projects(),
    }
}
