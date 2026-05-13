import { getDb } from './db'
import type { ClaudeAuthState, ClaudeAuthPatch, ClaudeCloudProvider } from '../shared/types'

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
}

function readRow(): Row | undefined {
  const db = getDb()
  return db
    .prepare('SELECT cloud_provider, auth_api_key, auth_token, auth_base_url, auth_aws_region, auth_vertex_project_id, auth_vertex_region FROM claude_global_settings WHERE id = 1')
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
    vertexRegion: row?.auth_vertex_region ?? ''
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
    auth_vertex_region: patch.vertexRegion !== undefined ? patch.vertexRegion : (existing?.auth_vertex_region ?? '')
  }
  const now = Date.now()
  db.prepare(
    `UPDATE claude_global_settings
     SET cloud_provider = ?, auth_api_key = ?, auth_token = ?, auth_base_url = ?,
         auth_aws_region = ?, auth_vertex_project_id = ?, auth_vertex_region = ?, updated_at = ?
     WHERE id = 1`
  ).run(
    next.cloud_provider, next.auth_api_key, next.auth_token, next.auth_base_url,
    next.auth_aws_region, next.auth_vertex_project_id, next.auth_vertex_region, now
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
  if (row.cloud_provider === 'bedrock') env.CLAUDE_CODE_USE_BEDROCK = '1'
  if (row.cloud_provider === 'vertex') env.CLAUDE_CODE_USE_VERTEX = '1'
  if (row.auth_api_key) env.ANTHROPIC_API_KEY = row.auth_api_key
  if (row.auth_token) env.ANTHROPIC_AUTH_TOKEN = row.auth_token
  if (row.auth_base_url) {
    if (row.cloud_provider === 'anthropic' || row.cloud_provider === 'foundry') {
      env.ANTHROPIC_BASE_URL = row.auth_base_url
    } else if (row.cloud_provider === 'bedrock') {
      env.ANTHROPIC_BEDROCK_BASE_URL = row.auth_base_url
    } else if (row.cloud_provider === 'vertex') {
      env.ANTHROPIC_VERTEX_BASE_URL = row.auth_base_url
    }
  }
  if (row.cloud_provider === 'bedrock' && row.auth_aws_region) {
    env.AWS_REGION = row.auth_aws_region
  }
  if (row.cloud_provider === 'vertex') {
    if (row.auth_vertex_project_id) env.ANTHROPIC_VERTEX_PROJECT_ID = row.auth_vertex_project_id
    if (row.auth_vertex_region) env.CLOUD_ML_REGION = row.auth_vertex_region
  }
  return env
}
