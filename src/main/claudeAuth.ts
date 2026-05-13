import { getDb } from './db'
import type { ClaudeAuthState, ClaudeAuthPatch, ClaudeAuthTestResult, ClaudeCloudProvider } from '../shared/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_PROVIDERS: ClaudeCloudProvider[] = ['anthropic', 'bedrock', 'vertex', 'foundry']

// ---------------------------------------------------------------------------
// Internal read helper
// ---------------------------------------------------------------------------

type Row = {
  cloud_provider: string
  auth_api_key: string
  auth_token: string
  auth_base_url: string
  auth_aws_region: string
  auth_vertex_project_id: string
  auth_vertex_region: string
  auth_foundry_api_key: string
  auth_foundry_resource: string
  auth_foundry_base_url: string
  auth_bedrock_bearer_token: string
}

function readRow(): Row | undefined {
  const db = getDb()
  return db
    .prepare('SELECT cloud_provider, auth_api_key, auth_token, auth_base_url, auth_aws_region, auth_vertex_project_id, auth_vertex_region, auth_foundry_api_key, auth_foundry_resource, auth_foundry_base_url, auth_bedrock_bearer_token FROM claude_global_settings WHERE id = 1')
    .get() as Row | undefined
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getClaudeAuthState(): ClaudeAuthState {
  const row = readRow()
  return {
    cloudProvider: (row?.cloud_provider ?? 'anthropic') as ClaudeCloudProvider,
    hasApiKey: (row?.auth_api_key ?? '').length > 0,
    hasAuthToken: (row?.auth_token ?? '').length > 0,
    baseUrl: row?.auth_base_url ?? '',
    awsRegion: row?.auth_aws_region ?? '',
    vertexProjectId: row?.auth_vertex_project_id ?? '',
    vertexRegion: row?.auth_vertex_region ?? '',
    hasFoundryApiKey: (row?.auth_foundry_api_key ?? '').length > 0,
    foundryResource: row?.auth_foundry_resource ?? '',
    foundryBaseUrl: row?.auth_foundry_base_url ?? '',
    hasBedrockBearerToken: (row?.auth_bedrock_bearer_token ?? '').length > 0
  }
}

export function updateClaudeAuth(patch: ClaudeAuthPatch): ClaudeAuthState {
  if (patch.cloudProvider !== undefined && !VALID_PROVIDERS.includes(patch.cloudProvider)) {
    throw new Error(`[claudeAuth] Invalid cloudProvider: ${patch.cloudProvider}`)
  }
  const db = getDb()
  const existing = readRow()
  const next = {
    cloud_provider: patch.cloudProvider ?? existing?.cloud_provider ?? 'anthropic',
    auth_api_key: patch.apiKey !== undefined ? patch.apiKey : (existing?.auth_api_key ?? ''),
    auth_token: patch.authToken !== undefined ? patch.authToken : (existing?.auth_token ?? ''),
    auth_base_url: patch.baseUrl !== undefined ? patch.baseUrl : (existing?.auth_base_url ?? ''),
    auth_aws_region: patch.awsRegion !== undefined ? patch.awsRegion : (existing?.auth_aws_region ?? ''),
    auth_vertex_project_id: patch.vertexProjectId !== undefined ? patch.vertexProjectId : (existing?.auth_vertex_project_id ?? ''),
    auth_vertex_region: patch.vertexRegion !== undefined ? patch.vertexRegion : (existing?.auth_vertex_region ?? ''),
    auth_foundry_api_key: patch.foundryApiKey !== undefined ? patch.foundryApiKey : (existing?.auth_foundry_api_key ?? ''),
    auth_foundry_resource: patch.foundryResource !== undefined ? patch.foundryResource : (existing?.auth_foundry_resource ?? ''),
    auth_foundry_base_url: patch.foundryBaseUrl !== undefined ? patch.foundryBaseUrl : (existing?.auth_foundry_base_url ?? ''),
    auth_bedrock_bearer_token: patch.bedrockBearerToken !== undefined ? patch.bedrockBearerToken : (existing?.auth_bedrock_bearer_token ?? '')
  }
  const now = Date.now()
  db.prepare(
    `UPDATE claude_global_settings
     SET cloud_provider = ?, auth_api_key = ?, auth_token = ?, auth_base_url = ?,
         auth_aws_region = ?, auth_vertex_project_id = ?, auth_vertex_region = ?,
         auth_foundry_api_key = ?, auth_foundry_resource = ?, auth_foundry_base_url = ?,
         auth_bedrock_bearer_token = ?, updated_at = ?
     WHERE id = 1`
  ).run(
    next.cloud_provider, next.auth_api_key, next.auth_token, next.auth_base_url,
    next.auth_aws_region, next.auth_vertex_project_id, next.auth_vertex_region,
    next.auth_foundry_api_key, next.auth_foundry_resource, next.auth_foundry_base_url,
    next.auth_bedrock_bearer_token, now
  )
  return getClaudeAuthState()
}

/**
 * Compose plaintext env vars needed at claude launch time.
 * NEVER log values — they may contain a real API key.
 */
export function getClaudeAuthEnv(): Record<string, string> {
  const row = readRow()
  if (!row) return {}
  const env: Record<string, string> = {}

  if (row.cloud_provider === 'foundry') {
    env.CLAUDE_CODE_USE_FOUNDRY = '1'
    if (row.auth_foundry_api_key) env.ANTHROPIC_FOUNDRY_API_KEY = row.auth_foundry_api_key
    if (row.auth_foundry_resource) env.ANTHROPIC_FOUNDRY_RESOURCE = row.auth_foundry_resource
    if (row.auth_foundry_base_url) env.ANTHROPIC_FOUNDRY_BASE_URL = row.auth_foundry_base_url
    return env
  }

  if (row.cloud_provider === 'bedrock') {
    env.CLAUDE_CODE_USE_BEDROCK = '1'
    if (row.auth_aws_region) env.AWS_REGION = row.auth_aws_region
    if (row.auth_bedrock_bearer_token) env.AWS_BEARER_TOKEN_BEDROCK = row.auth_bedrock_bearer_token
    if (row.auth_base_url) env.ANTHROPIC_BEDROCK_BASE_URL = row.auth_base_url
    return env
  }

  if (row.cloud_provider === 'vertex') {
    env.CLAUDE_CODE_USE_VERTEX = '1'
    if (row.auth_vertex_project_id) env.ANTHROPIC_VERTEX_PROJECT_ID = row.auth_vertex_project_id
    if (row.auth_vertex_region) env.CLOUD_ML_REGION = row.auth_vertex_region
    if (row.auth_base_url) env.ANTHROPIC_VERTEX_BASE_URL = row.auth_base_url
    return env
  }

  // anthropic (default)
  if (row.auth_api_key) env.ANTHROPIC_API_KEY = row.auth_api_key
  if (row.auth_token) env.ANTHROPIC_AUTH_TOKEN = row.auth_token
  if (row.auth_base_url) env.ANTHROPIC_BASE_URL = row.auth_base_url
  return env
}

/**
 * Ping Anthropic's /v1/models endpoint to verify the configured API key.
 * Anthropic-only — Bedrock/Vertex auth lives in AWS/GCP SDKs, not here.
 * NEVER log the api key value — only the outcome.
 */
export async function testAnthropicConnection(): Promise<ClaudeAuthTestResult> {
  const row = readRow()
  if (!row) return { ok: false, reason: 'No auth row found' }
  if (row.cloud_provider !== 'anthropic') {
    return { ok: false, reason: 'Test only supported for Anthropic provider' }
  }
  if (!row.auth_api_key) {
    return { ok: false, reason: 'No API key set' }
  }

  // Prefer the user's configured base URL, then their shell env override, then
  // the canonical API endpoint as a final fallback.
  const base =
    row.auth_base_url || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
  const url = base.replace(/\/+$/, '') + '/v1/models'
  const started = Date.now()

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': row.auth_api_key,
        'anthropic-version': '2023-06-01'
      }
    })
    const durationMs = Date.now() - started
    if (res.ok) return { ok: true, durationMs }
    // Try to extract an error message without leaking sensitive context
    let reason = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      if (body?.error?.message) reason = body.error.message
    } catch {
      // ignore JSON parse failures — keep the HTTP status as reason
    }
    return { ok: false, reason, status: res.status }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'Network error'
    }
  }
}
