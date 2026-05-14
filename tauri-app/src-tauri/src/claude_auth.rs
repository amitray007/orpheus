// Auth state for claude_global_settings singleton — mirrors src/main/claudeAuth.ts.
// Plaintext SQLite only (schema v16+). No Keychain.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::{Db, DbError};
use crate::util::now_ms;

// ---------------------------------------------------------------------------
// Provider enum
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudProvider {
    Anthropic,
    Bedrock,
    Vertex,
    Foundry,
}

impl CloudProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            CloudProvider::Anthropic => "anthropic",
            CloudProvider::Bedrock => "bedrock",
            CloudProvider::Vertex => "vertex",
            CloudProvider::Foundry => "foundry",
        }
    }
}

impl TryFrom<&str> for CloudProvider {
    type Error = String;

    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "anthropic" => Ok(CloudProvider::Anthropic),
            "bedrock" => Ok(CloudProvider::Bedrock),
            "vertex" => Ok(CloudProvider::Vertex),
            "foundry" => Ok(CloudProvider::Foundry),
            other => Err(format!("[claudeAuth] Invalid cloudProvider: {other}")),
        }
    }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Mirrors ClaudeAuthState in shared/types — no secrets exposed, only presence flags.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthState {
    pub cloud_provider: CloudProvider,
    pub has_api_key: bool,
    pub has_auth_token: bool,
    pub base_url: String,
    pub aws_region: String,
    pub vertex_project_id: String,
    pub vertex_region: String,
    pub has_foundry_api_key: bool,
    pub foundry_resource: String,
    pub foundry_base_url: String,
    pub has_bedrock_bearer_token: bool,
}

/// Sparse patch — only supplied fields are written.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthPatch {
    pub cloud_provider: Option<CloudProvider>,
    pub api_key: Option<String>,
    pub auth_token: Option<String>,
    pub base_url: Option<String>,
    pub aws_region: Option<String>,
    pub vertex_project_id: Option<String>,
    pub vertex_region: Option<String>,
    pub foundry_api_key: Option<String>,
    pub foundry_resource: Option<String>,
    pub foundry_base_url: Option<String>,
    pub bedrock_bearer_token: Option<String>,
}

/// Mirrors ClaudeAuthTestResult in shared/types.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAuthTestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

// ---------------------------------------------------------------------------
// Internal row
// ---------------------------------------------------------------------------

struct AuthRow {
    cloud_provider: String,
    auth_api_key: String,
    auth_token: String,
    auth_base_url: String,
    auth_aws_region: String,
    auth_vertex_project_id: String,
    auth_vertex_region: String,
    auth_foundry_api_key: String,
    auth_foundry_resource: String,
    auth_foundry_base_url: String,
    auth_bedrock_bearer_token: String,
}

fn read_row(db: &Db) -> Result<Option<AuthRow>, DbError> {
    let result = db.conn().query_row(
        "SELECT cloud_provider, auth_api_key, auth_token, auth_base_url,
                auth_aws_region, auth_vertex_project_id, auth_vertex_region,
                auth_foundry_api_key, auth_foundry_resource, auth_foundry_base_url,
                auth_bedrock_bearer_token
         FROM claude_global_settings WHERE id = 1",
        [],
        |r| {
            Ok(AuthRow {
                cloud_provider: r.get::<_, String>(0).unwrap_or_default(),
                auth_api_key: r.get::<_, String>(1).unwrap_or_default(),
                auth_token: r.get::<_, String>(2).unwrap_or_default(),
                auth_base_url: r.get::<_, String>(3).unwrap_or_default(),
                auth_aws_region: r.get::<_, String>(4).unwrap_or_default(),
                auth_vertex_project_id: r.get::<_, String>(5).unwrap_or_default(),
                auth_vertex_region: r.get::<_, String>(6).unwrap_or_default(),
                auth_foundry_api_key: r.get::<_, String>(7).unwrap_or_default(),
                auth_foundry_resource: r.get::<_, String>(8).unwrap_or_default(),
                auth_foundry_base_url: r.get::<_, String>(9).unwrap_or_default(),
                auth_bedrock_bearer_token: r.get::<_, String>(10).unwrap_or_default(),
            })
        },
    );
    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(DbError::from(e)),
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Return the auth state (no secrets in the returned struct — only presence flags).
pub fn get_claude_auth_state(db: &Db) -> Result<ClaudeAuthState, DbError> {
    let row = read_row(db)?.unwrap_or_else(|| AuthRow {
        cloud_provider: "anthropic".into(),
        auth_api_key: String::new(),
        auth_token: String::new(),
        auth_base_url: String::new(),
        auth_aws_region: String::new(),
        auth_vertex_project_id: String::new(),
        auth_vertex_region: String::new(),
        auth_foundry_api_key: String::new(),
        auth_foundry_resource: String::new(),
        auth_foundry_base_url: String::new(),
        auth_bedrock_bearer_token: String::new(),
    });

    let cloud_provider = CloudProvider::try_from(row.cloud_provider.as_str())
        .unwrap_or(CloudProvider::Anthropic);

    Ok(ClaudeAuthState {
        cloud_provider,
        has_api_key: !row.auth_api_key.is_empty(),
        has_auth_token: !row.auth_token.is_empty(),
        base_url: row.auth_base_url,
        aws_region: row.auth_aws_region,
        vertex_project_id: row.auth_vertex_project_id,
        vertex_region: row.auth_vertex_region,
        has_foundry_api_key: !row.auth_foundry_api_key.is_empty(),
        foundry_resource: row.auth_foundry_resource,
        foundry_base_url: row.auth_foundry_base_url,
        has_bedrock_bearer_token: !row.auth_bedrock_bearer_token.is_empty(),
    })
}

/// Write a sparse patch over the auth columns. Returns the new state.
pub fn update_claude_auth(db: &Db, patch: ClaudeAuthPatch) -> Result<ClaudeAuthState, DbError> {
    let existing = read_row(db)?.unwrap_or_else(|| AuthRow {
        cloud_provider: "anthropic".into(),
        auth_api_key: String::new(),
        auth_token: String::new(),
        auth_base_url: String::new(),
        auth_aws_region: String::new(),
        auth_vertex_project_id: String::new(),
        auth_vertex_region: String::new(),
        auth_foundry_api_key: String::new(),
        auth_foundry_resource: String::new(),
        auth_foundry_base_url: String::new(),
        auth_bedrock_bearer_token: String::new(),
    });

    let provider_str = patch
        .cloud_provider
        .as_ref()
        .map(|p| p.as_str().to_owned())
        .unwrap_or(existing.cloud_provider);
    let api_key = patch.api_key.unwrap_or(existing.auth_api_key);
    let auth_token = patch.auth_token.unwrap_or(existing.auth_token);
    let base_url = patch.base_url.unwrap_or(existing.auth_base_url);
    let aws_region = patch.aws_region.unwrap_or(existing.auth_aws_region);
    let vertex_project_id = patch.vertex_project_id.unwrap_or(existing.auth_vertex_project_id);
    let vertex_region = patch.vertex_region.unwrap_or(existing.auth_vertex_region);
    let foundry_api_key = patch.foundry_api_key.unwrap_or(existing.auth_foundry_api_key);
    let foundry_resource = patch.foundry_resource.unwrap_or(existing.auth_foundry_resource);
    let foundry_base_url = patch.foundry_base_url.unwrap_or(existing.auth_foundry_base_url);
    let bedrock_bearer_token = patch.bedrock_bearer_token.unwrap_or(existing.auth_bedrock_bearer_token);

    let now = now_ms();
    db.conn().execute(
        "UPDATE claude_global_settings
         SET cloud_provider = ?1, auth_api_key = ?2, auth_token = ?3, auth_base_url = ?4,
             auth_aws_region = ?5, auth_vertex_project_id = ?6, auth_vertex_region = ?7,
             auth_foundry_api_key = ?8, auth_foundry_resource = ?9, auth_foundry_base_url = ?10,
             auth_bedrock_bearer_token = ?11, updated_at = ?12
         WHERE id = 1",
        params![
            provider_str,
            api_key,
            auth_token,
            base_url,
            aws_region,
            vertex_project_id,
            vertex_region,
            foundry_api_key,
            foundry_resource,
            foundry_base_url,
            bedrock_bearer_token,
            now,
        ],
    )?;

    get_claude_auth_state(db)
}

/// Compose provider-specific env vars for use at claude launch time.
/// NEVER log the returned values — they may contain real secrets.
pub fn get_claude_auth_env(db: &Db) -> Result<HashMap<String, String>, DbError> {
    let row = match read_row(db)? {
        Some(r) => r,
        None => return Ok(HashMap::new()),
    };

    let mut env: HashMap<String, String> = HashMap::new();

    match row.cloud_provider.as_str() {
        "foundry" => {
            env.insert("CLAUDE_CODE_USE_FOUNDRY".into(), "1".into());
            if !row.auth_foundry_api_key.is_empty() {
                env.insert("ANTHROPIC_FOUNDRY_API_KEY".into(), row.auth_foundry_api_key);
            }
            if !row.auth_foundry_resource.is_empty() {
                env.insert("ANTHROPIC_FOUNDRY_RESOURCE".into(), row.auth_foundry_resource);
            }
            if !row.auth_foundry_base_url.is_empty() {
                env.insert("ANTHROPIC_FOUNDRY_BASE_URL".into(), row.auth_foundry_base_url);
            }
        }
        "bedrock" => {
            env.insert("CLAUDE_CODE_USE_BEDROCK".into(), "1".into());
            if !row.auth_aws_region.is_empty() {
                env.insert("AWS_REGION".into(), row.auth_aws_region);
            }
            if !row.auth_bedrock_bearer_token.is_empty() {
                env.insert("AWS_BEARER_TOKEN_BEDROCK".into(), row.auth_bedrock_bearer_token);
            }
            if !row.auth_base_url.is_empty() {
                env.insert("ANTHROPIC_BEDROCK_BASE_URL".into(), row.auth_base_url);
            }
        }
        "vertex" => {
            env.insert("CLAUDE_CODE_USE_VERTEX".into(), "1".into());
            if !row.auth_vertex_project_id.is_empty() {
                env.insert("ANTHROPIC_VERTEX_PROJECT_ID".into(), row.auth_vertex_project_id);
            }
            if !row.auth_vertex_region.is_empty() {
                env.insert("CLOUD_ML_REGION".into(), row.auth_vertex_region);
            }
            if !row.auth_base_url.is_empty() {
                env.insert("ANTHROPIC_VERTEX_BASE_URL".into(), row.auth_base_url);
            }
        }
        _ => {
            // anthropic (default)
            if !row.auth_api_key.is_empty() {
                env.insert("ANTHROPIC_API_KEY".into(), row.auth_api_key);
            }
            if !row.auth_token.is_empty() {
                env.insert("ANTHROPIC_AUTH_TOKEN".into(), row.auth_token);
            }
            if !row.auth_base_url.is_empty() {
                env.insert("ANTHROPIC_BASE_URL".into(), row.auth_base_url);
            }
        }
    }

    Ok(env)
}

/// Ping Anthropic /v1/models to verify the stored API key.
/// Anthropic provider only — Bedrock/Vertex auth lives in their own SDKs.
/// NEVER log the API key value — only log the outcome.
pub async fn test_anthropic_connection(db: &Db) -> ClaudeAuthTestResult {
    let row = match read_row(db) {
        Ok(Some(r)) => r,
        Ok(None) => return ClaudeAuthTestResult { ok: false, duration_ms: None, reason: Some("No auth row found".into()), status: None },
        Err(e) => return ClaudeAuthTestResult { ok: false, duration_ms: None, reason: Some(e.to_string()), status: None },
    };

    if row.cloud_provider != "anthropic" {
        return ClaudeAuthTestResult {
            ok: false,
            duration_ms: None,
            reason: Some("Test only supported for Anthropic provider".into()),
            status: None,
        };
    }
    if row.auth_api_key.is_empty() {
        return ClaudeAuthTestResult {
            ok: false,
            duration_ms: None,
            reason: Some("No API key set".into()),
            status: None,
        };
    }

    let base = if !row.auth_base_url.is_empty() {
        row.auth_base_url.clone()
    } else {
        std::env::var("ANTHROPIC_BASE_URL")
            .unwrap_or_else(|_| "https://api.anthropic.com".into())
    };
    let url = format!("{}/v1/models", base.trim_end_matches('/'));

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => return ClaudeAuthTestResult { ok: false, duration_ms: None, reason: Some(e.to_string()), status: None },
    };

    let started = Instant::now();
    let result = client
        .get(&url)
        .header("x-api-key", &row.auth_api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await;

    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(res) => {
            let status = res.status().as_u16();
            if res.status().is_success() {
                ClaudeAuthTestResult { ok: true, duration_ms: Some(duration_ms), reason: None, status: None }
            } else {
                // Try to extract the error message body without logging secrets.
                let reason = match res.json::<serde_json::Value>().await {
                    Ok(body) => body
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .map(|s| s.to_owned())
                        .unwrap_or_else(|| format!("HTTP {status}")),
                    Err(_) => format!("HTTP {status}"),
                };
                ClaudeAuthTestResult { ok: false, duration_ms: Some(duration_ms), reason: Some(reason), status: Some(status) }
            }
        }
        Err(e) => ClaudeAuthTestResult {
            ok: false,
            duration_ms: Some(duration_ms),
            reason: Some(e.to_string()),
            status: None,
        },
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn temp_db() -> (Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("test.sqlite");
        let db = Db::open_at(&path).expect("open_at");
        (db, dir)
    }

    #[test]
    fn default_state_is_anthropic_empty() {
        let (db, _dir) = temp_db();
        let state = get_claude_auth_state(&db).expect("get");
        assert_eq!(state.cloud_provider, CloudProvider::Anthropic);
        assert!(!state.has_api_key);
        assert!(!state.has_auth_token);
        assert!(state.base_url.is_empty());
    }

    #[test]
    fn round_trip_api_key() {
        let (db, _dir) = temp_db();
        let patch = ClaudeAuthPatch {
            api_key: Some("sk-ant-test-key".into()),
            ..Default::default()
        };
        let state = update_claude_auth(&db, patch).expect("update");
        assert!(state.has_api_key);
        assert!(!state.has_auth_token);
    }

    #[test]
    fn round_trip_provider_bedrock() {
        let (db, _dir) = temp_db();
        let patch = ClaudeAuthPatch {
            cloud_provider: Some(CloudProvider::Bedrock),
            aws_region: Some("us-east-1".into()),
            ..Default::default()
        };
        let state = update_claude_auth(&db, patch).expect("update");
        assert_eq!(state.cloud_provider, CloudProvider::Bedrock);
        assert_eq!(state.aws_region, "us-east-1");
    }

    #[test]
    fn round_trip_provider_vertex() {
        let (db, _dir) = temp_db();
        let patch = ClaudeAuthPatch {
            cloud_provider: Some(CloudProvider::Vertex),
            vertex_project_id: Some("my-gcp-project".into()),
            vertex_region: Some("us-central1".into()),
            ..Default::default()
        };
        let state = update_claude_auth(&db, patch).expect("update");
        assert_eq!(state.cloud_provider, CloudProvider::Vertex);
        assert_eq!(state.vertex_project_id, "my-gcp-project");
        assert_eq!(state.vertex_region, "us-central1");
    }

    #[test]
    fn round_trip_provider_foundry() {
        let (db, _dir) = temp_db();
        let patch = ClaudeAuthPatch {
            cloud_provider: Some(CloudProvider::Foundry),
            foundry_api_key: Some("foundry-key".into()),
            foundry_resource: Some("my-resource".into()),
            foundry_base_url: Some("https://foundry.example.com".into()),
            ..Default::default()
        };
        let state = update_claude_auth(&db, patch).expect("update");
        assert_eq!(state.cloud_provider, CloudProvider::Foundry);
        assert!(state.has_foundry_api_key);
        assert_eq!(state.foundry_resource, "my-resource");
        assert_eq!(state.foundry_base_url, "https://foundry.example.com");
    }

    #[test]
    fn auth_env_anthropic() {
        let (db, _dir) = temp_db();
        let patch = ClaudeAuthPatch {
            api_key: Some("sk-ant-test".into()),
            base_url: Some("https://custom.api.com".into()),
            ..Default::default()
        };
        update_claude_auth(&db, patch).expect("update");
        let env = get_claude_auth_env(&db).expect("env");
        assert_eq!(env.get("ANTHROPIC_API_KEY").map(|s| s.as_str()), Some("sk-ant-test"));
        assert_eq!(env.get("ANTHROPIC_BASE_URL").map(|s| s.as_str()), Some("https://custom.api.com"));
        assert!(!env.contains_key("CLAUDE_CODE_USE_BEDROCK"));
        assert!(!env.contains_key("CLAUDE_CODE_USE_VERTEX"));
        assert!(!env.contains_key("CLAUDE_CODE_USE_FOUNDRY"));
    }

    #[test]
    fn auth_env_bedrock() {
        let (db, _dir) = temp_db();
        let patch = ClaudeAuthPatch {
            cloud_provider: Some(CloudProvider::Bedrock),
            aws_region: Some("eu-west-1".into()),
            ..Default::default()
        };
        update_claude_auth(&db, patch).expect("update");
        let env = get_claude_auth_env(&db).expect("env");
        assert_eq!(env.get("CLAUDE_CODE_USE_BEDROCK").map(|s| s.as_str()), Some("1"));
        assert_eq!(env.get("AWS_REGION").map(|s| s.as_str()), Some("eu-west-1"));
        assert!(!env.contains_key("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn auth_env_vertex() {
        let (db, _dir) = temp_db();
        let patch = ClaudeAuthPatch {
            cloud_provider: Some(CloudProvider::Vertex),
            vertex_project_id: Some("proj-123".into()),
            vertex_region: Some("us-west1".into()),
            ..Default::default()
        };
        update_claude_auth(&db, patch).expect("update");
        let env = get_claude_auth_env(&db).expect("env");
        assert_eq!(env.get("CLAUDE_CODE_USE_VERTEX").map(|s| s.as_str()), Some("1"));
        assert_eq!(env.get("ANTHROPIC_VERTEX_PROJECT_ID").map(|s| s.as_str()), Some("proj-123"));
        assert_eq!(env.get("CLOUD_ML_REGION").map(|s| s.as_str()), Some("us-west1"));
    }

    #[test]
    fn auth_env_foundry() {
        let (db, _dir) = temp_db();
        let patch = ClaudeAuthPatch {
            cloud_provider: Some(CloudProvider::Foundry),
            foundry_api_key: Some("fk-abc".into()),
            foundry_resource: Some("res-x".into()),
            foundry_base_url: Some("https://foundry.local".into()),
            ..Default::default()
        };
        update_claude_auth(&db, patch).expect("update");
        let env = get_claude_auth_env(&db).expect("env");
        assert_eq!(env.get("CLAUDE_CODE_USE_FOUNDRY").map(|s| s.as_str()), Some("1"));
        assert_eq!(env.get("ANTHROPIC_FOUNDRY_API_KEY").map(|s| s.as_str()), Some("fk-abc"));
        assert_eq!(env.get("ANTHROPIC_FOUNDRY_RESOURCE").map(|s| s.as_str()), Some("res-x"));
        assert_eq!(env.get("ANTHROPIC_FOUNDRY_BASE_URL").map(|s| s.as_str()), Some("https://foundry.local"));
    }

    /// Requires a real Anthropic API key — skip in CI.
    #[tokio::test]
    #[ignore]
    async fn test_connection_live() {
        let (db, _dir) = temp_db();
        let key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY not set");
        let patch = ClaudeAuthPatch {
            api_key: Some(key),
            ..Default::default()
        };
        update_claude_auth(&db, patch).expect("update");
        let result = test_anthropic_connection(&db).await;
        assert!(result.ok, "expected ok=true, got: {:?}", result.reason);
    }

    #[tokio::test]
    async fn test_connection_wrong_provider() {
        let (db, _dir) = temp_db();
        let patch = ClaudeAuthPatch {
            cloud_provider: Some(CloudProvider::Bedrock),
            ..Default::default()
        };
        update_claude_auth(&db, patch).expect("update");
        let result = test_anthropic_connection(&db).await;
        assert!(!result.ok);
        assert!(result.reason.as_deref().unwrap_or("").contains("Anthropic provider"));
    }

    #[tokio::test]
    async fn test_connection_no_key() {
        let (db, _dir) = temp_db();
        let result = test_anthropic_connection(&db).await;
        assert!(!result.ok);
        assert!(result.reason.as_deref().unwrap_or("").contains("No API key"));
    }
}
