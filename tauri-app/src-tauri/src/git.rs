// Git status helper — mirrors src/main/git.ts.
// Shells out to the system `git` binary (same as the TS version using execFileSync).
// Returns None if the path is not inside a git repo or git is unavailable.
// Errors are swallowed — git failures should never crash Orpheus.

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Lines added in working-tree vs HEAD.
    pub insertions: u32,
    /// Lines removed in working-tree vs HEAD.
    pub deletions: u32,
    /// True when insertions or deletions > 0, or untracked files exist.
    pub has_changes: bool,
    /// Current branch name, or None when HEAD is detached.
    pub branch: Option<String>,
}

/// Return git status for `cwd`, or None if cwd is not a git repo or git unavailable.
pub fn get_git_status(cwd: &Path) -> Option<GitStatus> {
    if cwd.as_os_str().is_empty() {
        return None;
    }

    // Quick check: is this a git repo?
    let ok = Command::new("git")
        .args(["-C", &cwd.to_string_lossy(), "rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ok {
        return None;
    }

    let branch = read_branch(cwd);
    let (insertions, deletions) = read_diff_stats(cwd);
    let untracked = read_untracked_count(cwd);

    let has_changes = insertions > 0 || deletions > 0 || untracked > 0;
    Some(GitStatus { insertions, deletions, has_changes, branch })
}

fn read_branch(cwd: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["-C", &cwd.to_string_lossy(), "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    // Detached HEAD reports literal "HEAD"
    if s == "HEAD" { None } else { Some(s) }
}

fn read_diff_stats(cwd: &Path) -> (u32, u32) {
    let out = match Command::new("git")
        .args(["-C", &cwd.to_string_lossy(), "diff", "--shortstat", "HEAD"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return (0, 0),
    };
    if !out.status.success() {
        return (0, 0);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let ins = parse_count(&text, "insertion");
    let del = parse_count(&text, "deletion");
    (ins, del)
}

// Extract a count from `git diff --shortstat` output like "2 insertions(+)".
fn parse_count(text: &str, keyword: &str) -> u32 {
    // Find " N insertion" or " N deletion"
    let mut chars = text.char_indices().peekable();
    while let Some((i, _)) = chars.find(|(_, c)| c.is_ascii_digit()) {
        // Collect the full number
        let mut end = i;
        while end < text.len() && text.as_bytes()[end].is_ascii_digit() {
            end += 1;
        }
        let n: u32 = text[i..end].parse().unwrap_or(0);
        // Check if the text after the digits contains our keyword
        if text[end..].trim_start().starts_with(keyword) {
            return n;
        }
    }
    0
}

fn read_untracked_count(cwd: &Path) -> u32 {
    let out = match Command::new("git")
        .args(["-C", &cwd.to_string_lossy(), "ls-files", "--others", "--exclude-standard"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return 0,
    };
    if !out.status.success() {
        return 0;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().filter(|l| !l.is_empty()).count() as u32
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn init_repo(dir: &std::path::Path) {
        Command::new("git").args(["init"]).current_dir(dir).output().unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(dir)
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(dir)
            .output()
            .unwrap();
    }

    #[test]
    fn returns_none_for_non_repo() {
        let dir = tempfile::tempdir().unwrap();
        // Plain directory, no git init
        let result = get_git_status(dir.path());
        assert!(result.is_none());
    }

    #[test]
    fn returns_none_for_empty_path() {
        let result = get_git_status(Path::new(""));
        assert!(result.is_none());
    }

    #[test]
    fn clean_repo_has_no_changes() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        // Write and commit a file
        std::fs::write(dir.path().join("hello.txt"), "hello\n").unwrap();
        Command::new("git").args(["add", "."]).current_dir(dir.path()).output().unwrap();
        Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(dir.path())
            .output()
            .unwrap();

        let status = get_git_status(dir.path()).expect("status");
        assert!(!status.has_changes);
        assert_eq!(status.insertions, 0);
        assert_eq!(status.deletions, 0);
        assert!(status.branch.is_some());
    }

    #[test]
    fn modified_file_detected() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        std::fs::write(dir.path().join("file.txt"), "original\n").unwrap();
        Command::new("git").args(["add", "."]).current_dir(dir.path()).output().unwrap();
        Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(dir.path())
            .output()
            .unwrap();

        // Modify the file — adds 1 line, removes 1 line net = change
        std::fs::write(dir.path().join("file.txt"), "changed\n").unwrap();

        let status = get_git_status(dir.path()).expect("status");
        assert!(status.has_changes);
    }

    #[test]
    fn untracked_files_detected() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        // Commit something so HEAD exists
        std::fs::write(dir.path().join("a.txt"), "a\n").unwrap();
        Command::new("git").args(["add", "."]).current_dir(dir.path()).output().unwrap();
        Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(dir.path())
            .output()
            .unwrap();

        // Add an untracked file
        std::fs::write(dir.path().join("untracked.txt"), "new\n").unwrap();

        let status = get_git_status(dir.path()).expect("status");
        assert!(status.has_changes);
    }

    #[test]
    fn parse_count_extracts_insertions() {
        let text = " 2 files changed, 113 insertions(+), 0 deletions(-)";
        assert_eq!(parse_count(text, "insertion"), 113);
        assert_eq!(parse_count(text, "deletion"), 0);
    }
}
