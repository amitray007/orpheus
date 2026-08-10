import assert from 'node:assert/strict'

// claudeUsage.ts's own imports are NOT electron-free: it pulls in
// db/dashboardCache.ts -> db/index.ts (electron's `app`) and
// claudeSettings.ts -> workspaces.ts (electron's `BrowserWindow`)
// transitively, even though the one export this script exercises
// (resolveOAuthTokenFromEnv) touches neither. Booting the real app to test
// a pure string-validation function would be disproportionate, so — same
// precedent as scripts/verify-project-add.ts's testAddProjectBroadcasts —
// this uses `bun:test`'s `mock.module()` (confirmed to work under a plain
// `bun run` script, not just `bun test`) to stub out exactly the modules
// that would otherwise fail to load outside Electron, then dynamically
// imports the REAL claudeUsage.ts so resolveOAuthTokenFromEnv itself is
// never faked.
const { mock } = await import('bun:test')

const claudeUsageDir = new URL('../src/main/', import.meta.url)
const abs = (rel: string): string => new URL(rel, claudeUsageDir).pathname

mock.module('electron', () => ({ app: { getPath: () => '' }, BrowserWindow: {} }))
mock.module(abs('db/index.ts'), () => ({ getDb: () => undefined }))
mock.module(abs('db/dashboardCache.ts'), () => ({
  DASHBOARD_CACHE_KEYS: { claudeUsage: 'claude_usage' },
  readDashboardCache: () => null,
  writeDashboardCache: () => undefined
}))
mock.module(abs('claudeSettings.ts'), () => ({
  getClaudeGlobalSettings: () => ({ customEnvVars: {} })
}))

const { resolveOAuthTokenFromEnv } = await import('../src/main/claudeUsage')

// A valid sk-ant-oat… value from processEnv is returned when customEnvVars
// doesn't carry the key at all.
assert.equal(
  resolveOAuthTokenFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-from-process-env' }, {}),
  'sk-ant-oat-from-process-env'
)

// Surrounding whitespace on a processEnv value is trimmed.
assert.equal(
  resolveOAuthTokenFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: '  sk-ant-oat-padded  ' }, {}),
  'sk-ant-oat-padded'
)

// A valid sk-ant-oat… value from customEnvVars (Orpheus's own Settings >
// Claude > Developer > Env Vars UI) is returned when processEnv doesn't
// have it — this is the primary real-world path for env-var auth in
// Orpheus, so it must work standalone.
assert.equal(
  resolveOAuthTokenFromEnv({}, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-from-settings' }),
  'sk-ant-oat-from-settings'
)

// Surrounding whitespace on a customEnvVars value is trimmed too.
assert.equal(
  resolveOAuthTokenFromEnv({}, { CLAUDE_CODE_OAUTH_TOKEN: '  sk-ant-oat-settings-padded  ' }),
  'sk-ant-oat-settings-padded'
)

// PRECEDENCE: when BOTH sources carry a different valid token, the
// Orpheus-configured customEnvVars value wins over process.env. This is
// deliberate — a user's explicit in-app setting must beat a stale/ambient
// process environment variable (e.g. a leftover shell export), or editing
// the Settings field would appear to do nothing.
assert.equal(
  resolveOAuthTokenFromEnv(
    { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-process-env-value' },
    { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-custom-env-vars-value' }
  ),
  'sk-ant-oat-custom-env-vars-value'
)

// An sk-ant-api… console API key is a DIFFERENT credential class (not a
// valid bearer token for the usage endpoint) and must be rejected in
// EITHER source, so a misconfigured API key degrades to the honest
// { unavailable: 'no-auth' } rather than a misleading 'error' state.
assert.equal(
  resolveOAuthTokenFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-api03-console-key' }, {}),
  null
)
assert.equal(
  resolveOAuthTokenFromEnv({}, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-api03-console-key' }),
  null
)

// Empty string, whitespace-only, and a missing key in both sources all
// resolve to null.
assert.equal(resolveOAuthTokenFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: '' }, {}), null)
assert.equal(resolveOAuthTokenFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: '   ' }, {}), null)
assert.equal(resolveOAuthTokenFromEnv({}, { CLAUDE_CODE_OAUTH_TOKEN: '' }), null)
assert.equal(resolveOAuthTokenFromEnv({}, { CLAUDE_CODE_OAUTH_TOKEN: '   ' }), null)
assert.equal(resolveOAuthTokenFromEnv({}, {}), null)

// A value missing the sk-ant-oat prefix entirely is rejected.
assert.equal(resolveOAuthTokenFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'garbage-value' }, {}), null)
assert.equal(resolveOAuthTokenFromEnv({}, { CLAUDE_CODE_OAUTH_TOKEN: 'garbage-value' }), null)

console.log('claude usage env-token resolution verification passed')
