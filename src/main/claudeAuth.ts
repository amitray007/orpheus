import { safeStorage } from 'electron'
import { getDb } from './db'
import type { ClaudeAuthState, ClaudeAuthPatch, ClaudeCloudProvider, ClaudeAuthSecrets } from '../shared/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMPTY_SECRETS: ClaudeAuthSecrets = { apiKey: '', baseUrl: '', authToken: '' }

const VALID_PROVIDERS: ClaudeCloudProvider[] = ['anthropic', 'bedrock', 'vertex', 'foundry']

// ---------------------------------------------------------------------------
// Encryption helpers — wraps safeStorage so callers never touch it directly
// ---------------------------------------------------------------------------

function isEncAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function decryptSecrets(blob: Buffer | null): ClaudeAuthSecrets {
  if (!blob || blob.length === 0) return { ...EMPTY_SECRETS }
  try {
    const str = safeStorage.decryptString(blob)
    const parsed = JSON.parse(str)
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      authToken: typeof parsed.authToken === 'string' ? parsed.authToken : ''
    }
  } catch (err) {
    console.error('[claudeAuth] failed to decrypt secrets blob', err)
    return { ...EMPTY_SECRETS }
  }
}

function encryptSecrets(secrets: ClaudeAuthSecrets): Buffer | null {
  if (!isEncAvailable()) return null
  // Skip encryption if all empty — store null to save space
  if (!secrets.apiKey && !secrets.baseUrl && !secrets.authToken) return null
  return safeStorage.encryptString(JSON.stringify(secrets))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getClaudeAuthState(): ClaudeAuthState {
  const db = getDb()
  const row = db
    .prepare('SELECT cloud_provider, auth_encrypted_blob FROM claude_global_settings WHERE id = 1')
    .get() as { cloud_provider: string; auth_encrypted_blob: Buffer | null } | undefined

  const provider = (row?.cloud_provider ?? 'anthropic') as ClaudeCloudProvider
  const enc = isEncAvailable()
  const secrets = enc ? decryptSecrets(row?.auth_encrypted_blob ?? null) : EMPTY_SECRETS

  return {
    cloudProvider: provider,
    hasApiKey: secrets.apiKey.length > 0,
    hasAuthToken: secrets.authToken.length > 0,
    baseUrl: secrets.baseUrl,
    encryptionAvailable: enc
  }
}

export function updateClaudeAuth(patch: ClaudeAuthPatch): ClaudeAuthState {
  // Validate provider if provided
  if (patch.cloudProvider !== undefined && !VALID_PROVIDERS.includes(patch.cloudProvider)) {
    throw new Error(`[claudeAuth] Invalid cloudProvider: ${patch.cloudProvider}`)
  }

  const db = getDb()

  // Read current secrets
  const row = db
    .prepare('SELECT auth_encrypted_blob FROM claude_global_settings WHERE id = 1')
    .get() as { auth_encrypted_blob: Buffer | null } | undefined

  const existing = decryptSecrets(row?.auth_encrypted_blob ?? null)

  // Apply patch
  const next: ClaudeAuthSecrets = {
    apiKey: patch.apiKey !== undefined ? patch.apiKey : existing.apiKey,
    baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : existing.baseUrl,
    authToken: patch.authToken !== undefined ? patch.authToken : existing.authToken
  }

  const encryptedBlob = encryptSecrets(next)
  const now = Date.now()

  if (patch.cloudProvider) {
    db.prepare(
      'UPDATE claude_global_settings SET cloud_provider = ?, auth_encrypted_blob = ?, updated_at = ? WHERE id = 1'
    ).run(patch.cloudProvider, encryptedBlob, now)
  } else {
    db.prepare(
      'UPDATE claude_global_settings SET auth_encrypted_blob = ?, updated_at = ? WHERE id = 1'
    ).run(encryptedBlob, now)
  }

  return getClaudeAuthState()
}

/**
 * Compose the decrypted env vars needed at claude launch time.
 * NEVER log the returned values — they contain plaintext secrets.
 */
export function getClaudeAuthEnv(): Record<string, string> {
  const db = getDb()
  const row = db
    .prepare('SELECT cloud_provider, auth_encrypted_blob FROM claude_global_settings WHERE id = 1')
    .get() as { cloud_provider: string; auth_encrypted_blob: Buffer | null } | undefined

  if (!row || !isEncAvailable()) return {}

  const provider = row.cloud_provider as ClaudeCloudProvider
  const secrets = decryptSecrets(row.auth_encrypted_blob ?? null)

  const env: Record<string, string> = {}

  // Provider routing flags — claude reads CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX
  if (provider === 'bedrock') env.CLAUDE_CODE_USE_BEDROCK = '1'
  if (provider === 'vertex') env.CLAUDE_CODE_USE_VERTEX = '1'
  // Anthropic + Foundry use default routing — no extra flag needed

  // Auth credentials
  if (secrets.apiKey) env.ANTHROPIC_API_KEY = secrets.apiKey
  if (secrets.authToken) env.ANTHROPIC_AUTH_TOKEN = secrets.authToken

  // Base URL env var depends on provider
  if (secrets.baseUrl) {
    if (provider === 'anthropic' || provider === 'foundry') {
      env.ANTHROPIC_BASE_URL = secrets.baseUrl
    } else if (provider === 'bedrock') {
      env.ANTHROPIC_BEDROCK_BASE_URL = secrets.baseUrl
    } else if (provider === 'vertex') {
      env.ANTHROPIC_VERTEX_BASE_URL = secrets.baseUrl
    }
  }

  return env
}
