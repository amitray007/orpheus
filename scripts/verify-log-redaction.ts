import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import {
  LOG_REDACTED_VALUE,
  isSensitiveLogKey,
  redactLogRecord,
  redactLogString,
  redactLogValue
} from '../src/main/logRedaction'
import {
  canonicalizeRendererDiagEvent,
  canonicalizeMainDiagEvent,
  diag,
  ingestDiagEvent,
  logDiagMain,
  setDiagCategoryFlags,
  subscribeDiag
} from '../src/main/diagCore'
import {
  sanitizeDiagnosticRowForOutput,
  sanitizeDiagnosticRowsForOutput
} from '../src/main/diagnosticOutputRedaction'
import { writePrivateDiagnosticReportFiles } from '../src/main/diagnosticExportFiles'
import { isSafeConsoleBoundaryInstalled, redactConsoleArguments } from '../src/main/safeConsole'
import { isTrustedRendererUrl } from '../src/main/rendererTrust'

const secretValues = [
  'cmd-token-value',
  'runtime-lease-value',
  'custom-service-token-value',
  'anthropic-api-value',
  'future-credential-value',
  'nested-password-value'
]

const result = redactLogValue({
  workspaceId: 'workspace-safe',
  projectId: 'project-safe',
  leaseId: 'lease-id-safe',
  envKeys: ['ORPHEUS_CMD_TOKEN', 'TERM', 'PATH'],
  ORPHEUS_CMD_TOKEN: secretValues[0],
  ORPHEUS_RUNTIME_LEASE_TOKEN: secretValues[1],
  X_CUSTOM_SERVICE_TOKEN: secretValues[2],
  ANTHROPIC_API_KEY: secretValues[3],
  futureSessionCredential: secretValues[4],
  nested: {
    password: secretValues[5],
    cwd: '/safe/project'
  }
}) as Record<string, unknown>

const serialized = JSON.stringify(result)
for (const secret of secretValues) assert.doesNotMatch(serialized, new RegExp(secret))
assert.equal(result['workspaceId'], 'workspace-safe')
assert.equal(result['projectId'], 'project-safe')
assert.equal(result['leaseId'], 'lease-id-safe')
assert.deepEqual(result['envKeys'], ['ORPHEUS_CMD_TOKEN', 'TERM', 'PATH'])
assert.equal(Object.keys(result).includes('ORPHEUS_CMD_TOKEN'), false)
assert.equal(Object.keys(result).includes('futureSessionCredential'), false)
assert.equal(Object.values(result).includes(LOG_REDACTED_VALUE), true)
assert.equal(
  Object.keys(result).some((key) => key.startsWith('[REDACTED_KEY]')),
  true
)

for (const key of [
  'ORPHEUS_CMD_TOKEN',
  'ORPHEUS_RUNTIME_LEASE_TOKEN',
  'X_CUSTOM_SERVICE_TOKEN',
  'ANTHROPIC_API_KEY',
  'future_auth_token',
  'futuretoken',
  'servicecredential',
  'serviceClientSecret',
  'database-password',
  'tokenId',
  'tokenid',
  'keyId',
  'keyid',
  'secretId',
  'secretid',
  'access-token-id',
  'accesstokenid'
]) {
  assert.equal(isSensitiveLogKey(key), true, `${key} should be considered sensitive`)
}
for (const key of [
  'envKeys',
  'keyNames',
  'tokenCount',
  'tokenBytes',
  'tokenLength',
  'tokenPresent',
  'environmentName',
  'workspaceId',
  'leaseId'
]) {
  assert.equal(isSensitiveLogKey(key), false, `${key} should remain useful metadata`)
}
for (const nearMiss of ['token-count', 'token_count', 'TOKENCOUNT', 'env_keys']) {
  assert.equal(isSensitiveLogKey(nearMiss), true, `${nearMiss} must not bypass the exact allowlist`)
}

const circular: Record<string, unknown> = {
  safe: 'visible',
  authorization: 'Bearer raw-auth-secret'
}
circular['self'] = circular
const error = new Error('ORPHEUS_CMD_TOKEN=error-secret')
const formatted = JSON.stringify(redactLogValue({ circular, error }))
assert.doesNotMatch(formatted, /raw-auth-secret|error-secret/)
assert.match(formatted, /\[CIRCULAR\]/)
assert.match(formatted, /visible/)

for (const value of [
  'ORPHEUS_CMD_TOKEN=formatted-secret',
  "ORPHEUS_RUNTIME_LEASE_TOKEN: 'inspect-secret'",
  'futureAuth=future auth secret with spaces',
  'serviceClientSecret=client-secret-value',
  '{"headers":{"Authorization":"Bearer json-secret"},"safe":"visible"}',
  'request failed with Bearer bearer-secret',
  'provider returned sk-ant-api-secret',
  'github_pat_secret123'
]) {
  const safe = redactLogString(value)
  assert.doesNotMatch(
    safe,
    /formatted-secret|inspect-secret|future auth secret|client-secret-value|json-secret|bearer-secret|sk-ant-api-secret|github_pat_secret123/
  )
}

const credentialForms = [
  'https://url-user:url-password@example.test/path?safe=query-secret#fragment-secret',
  'Authorization: Basic dXNlcjpiYXNpYy1zZWNyZXQ=',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqd3Qtc2VjcmV0In0.jwt-signature-secret', // gitleaks:allow -- synthetic redaction fixture
  `AIza${'g'.repeat(35)}`,
  `npm_${'n'.repeat(36)}`,
  `sk_live_${'s'.repeat(32)}`,
  `ya29.${'y'.repeat(32)}`
]
const credentialOutput = redactLogString(credentialForms.join('\n'))
for (const leaked of [
  'url-user',
  'url-password',
  'query-secret',
  'fragment-secret', // gitleaks:allow -- synthetic redaction fixture
  'dXNlcjpiYXNpYy1zZWNyZXQ=',
  'jwt-signature-secret',
  `AIza${'g'.repeat(35)}`,
  `npm_${'n'.repeat(36)}`,
  `sk_live_${'s'.repeat(32)}`,
  `ya29.${'y'.repeat(32)}`
]) {
  assert.doesNotMatch(credentialOutput, new RegExp(leaked.replaceAll('.', '\\.')))
}

const structuredCredentials = redactLogValue({
  apikey: 'lower-api-secret',
  clientsecret: 'lower-client-secret',
  databasepassword: 'lower-db-secret',
  env: {
    SAFE_NAME: 'arbitrary-env-value'
  },
  headers: {
    'x-safe-name': 'arbitrary-header-value'
  },
  requestHeaders: [
    ['x-safe-tuple', 'tuple-header-value'],
    ['authorization', 'tuple-authorization-value']
  ],
  mcpServers: {
    internal: {
      command: '/safe/orpheus-mcp',
      args: ['--safe-looking', 'mcp-arg-secret'],
      env: { SAFE_NAME: 'mcp-env-secret' }
    }
  },
  'Authorization: Bearer property-name-secret': 'safe-property-value'
})
const structuredJson = JSON.stringify(structuredCredentials)
assert.doesNotMatch(
  structuredJson,
  /lower-api-secret|lower-client-secret|lower-db-secret|arbitrary-env-value|arbitrary-header-value|tuple-header-value|tuple-authorization-value|mcp-arg-secret|mcp-env-secret|property-name-secret/
)
assert.match(structuredJson, /SAFE_NAME|x-safe-name|x-safe-tuple|internal/)

const argvOutput = redactLogString(
  `--client-secret whitespace-argv-secret --safe visible --api-key=equals-argv-secret`
)
assert.doesNotMatch(argvOutput, /whitespace-argv-secret|equals-argv-secret/)
assert.match(argvOutput, /--client-secret|--api-key|--safe visible/)
const shortArgvOutput = redactLogString(
  '-u user:short-user-pass-secret -pATTACHED_SECRET -P short-password-secret -k=short-key-secret'
)
assert.doesNotMatch(
  shortArgvOutput,
  /short-user-pass-secret|ATTACHED_SECRET|short-password-secret|short-key-secret/
)
const unitSeparatedSecret = redactLogString('--token\x1f-dash-prefixed-secret\x1f--safe')
assert.doesNotMatch(unitSeparatedSecret, /dash-prefixed-secret/)
const standardAuthArgv = redactLogString(
  '--user user:long-user-secret --proxy-user proxy:long-proxy-user-secret ' +
    '-H "Authorization: Bearer short-header-secret" -b short-cookie-secret ' +
    '-H "X-Custom: arbitrary quoted header secret" -b "a=quoted cookie secret" ' +
    '--header x-auth:long-header-secret --cookie long-cookie-secret ' +
    '--oauth2-bearer oauth-bearer-secret'
)
assert.doesNotMatch(
  standardAuthArgv,
  /long-user-secret|long-proxy-user-secret|short-header-secret|short-cookie-secret|arbitrary quoted header secret|quoted cookie secret|long-header-secret|long-cookie-secret|oauth-bearer-secret/
)

let getterRuns = 0
const getterObject = Object.create(null) as Record<string, unknown>
Object.defineProperty(getterObject, 'token', {
  enumerable: true,
  get: () => {
    getterRuns++
    return 'getter-secret'
  }
})
const shared = { safe: 'shared-safe', token: 'shared-secret' }
const hostileProxy = new Proxy(
  {},
  {
    ownKeys: () => {
      throw new Error('proxy-secret')
    }
  }
)
const normalizedOddValues = redactLogValue({
  getterObject,
  hostileProxy,
  map: new Map<unknown, unknown>([
    ['apiKey', 'map-secret'],
    ['safe', shared]
  ]),
  set: new Set([shared, 'set-safe']),
  date: new Date('2026-07-28T00:00:00.000Z'),
  first: shared,
  second: shared,
  bytes: Buffer.from('buffer-secret')
})
const oddJson = JSON.stringify(normalizedOddValues)
assert.equal(getterRuns, 0)
assert.doesNotMatch(oddJson, /getter-secret|proxy-secret|map-secret|shared-secret|buffer-secret/)
assert.match(oddJson, /\[ACCESSOR\]|\[UNINSPECTABLE\]/)
assert.match(oddJson, /\[REFERENCE\]/)
assert.match(oddJson, /2026-07-28T00:00:00.000Z/)

const oversizedString = `token=preparse-cap-secret,${'x'.repeat(100_000)}`
const cappedOutput = redactLogString(oversizedString)
assert.doesNotMatch(cappedOutput, /preparse-cap-secret/)
assert.ok(cappedOutput.length < 9_000)
const oversizedArray = redactLogValue(Array.from({ length: 1_000 }, (_, index) => index))
assert.ok(Array.isArray(oversizedArray))
assert.ok(oversizedArray.length <= 257)
let farArrayGetterRuns = 0
const wideArray = Array.from({ length: 301 }, (_, index) => index)
Object.defineProperty(wideArray, '300', {
  enumerable: true,
  get: () => {
    farArrayGetterRuns++
    return 'far-array-secret'
  }
})
redactLogValue(wideArray)
assert.equal(farArrayGetterRuns, 0)
const wideObject = Object.fromEntries(
  Array.from({ length: 3_000 }, (_, index) => [`safeField${index}`, index])
)
const boundedWideObject = redactLogValue(wideObject) as Record<string, unknown>
assert.ok(Object.keys(boundedWideObject).length <= 2_048)

const mcpConfig = JSON.stringify({
  mcpServers: {
    internal: {
      command: '/safe/orpheus-mcp',
      env: {
        API_KEY: 'mcp-api-secret',
        SAFE_REGION: 'us-east-1',
        UNRECOGNIZABLE_VALUE: 'mcp-arbitrary-env-secret'
      },
      headers: {
        Authorization: 'Bearer mcp-header-secret'
      }
    }
  }
})
const redactedMcp = redactLogString(mcpConfig)
assert.doesNotMatch(
  redactedMcp,
  /mcp-api-secret|mcp-header-secret|mcp-arbitrary-env-secret|us-east-1/
)
assert.match(redactedMcp, /internal|SAFE_REGION|UNRECOGNIZABLE_VALUE/)
const mcpFlags = `--model\x1fopus\x1f--mcp-config\x1f${mcpConfig}\x1f--verbose`
const redactedMcpFlags = redactLogString(mcpFlags)
assert.doesNotMatch(
  redactedMcpFlags,
  /mcp-api-secret|mcp-header-secret|mcp-arbitrary-env-secret|us-east-1/
)
assert.match(redactedMcpFlags, /--model|--mcp-config|--verbose/)
let farMcpGetterRuns = 0
const wideMcpArgs = Array.from({ length: 301 }, (_, index) => `arg-${index}`)
Object.defineProperty(wideMcpArgs, '300', {
  enumerable: true,
  get: () => {
    farMcpGetterRuns++
    return 'far-mcp-secret'
  }
})
const boundedMcp = redactLogValue({ mcpServers: { internal: { args: wideMcpArgs } } })
assert.equal(farMcpGetterRuns, 0)
assert.ok(
  (boundedMcp as { mcpServers: { internal: { args: unknown[] } } }).mcpServers.internal.args
    .length <= 256
)

const primitiveContainers = JSON.stringify(
  redactLogValue({ headers: 'raw-header-container-secret', env: 42 })
)
assert.doesNotMatch(primitiveContainers, /raw-header-container-secret|42/)

const canonicalRenderer = canonicalizeRendererDiagEvent(
  {
    ts: 1,
    process: 'main',
    category: 'error',
    level: 'error',
    event: 'error.renderer',
    workspaceId: 'token=renderer-top-level-secret',
    message: 'Authorization: Bearer renderer-message-secret',
    data: {
      headers: { 'x-safe': 'renderer-header-secret' },
      env: { SAFE_NAME: 'renderer-env-secret' }
    },
    extraSecretField: 'renderer-extra-secret'
  },
  123_456
)
assert.ok(canonicalRenderer)
assert.equal(canonicalRenderer.process, 'renderer')
assert.equal(canonicalRenderer.ts, 123_456)
assert.equal(Object.prototype.hasOwnProperty.call(canonicalRenderer, 'extraSecretField'), false)
assert.doesNotMatch(
  JSON.stringify(canonicalRenderer),
  /renderer-top-level-secret|renderer-message-secret|renderer-header-secret|renderer-env-secret|renderer-extra-secret/
)
assert.equal(
  canonicalizeRendererDiagEvent({
    category: 'invalid',
    level: 'error',
    event: 'error.renderer'
  }),
  null
)
const validWorkspaceId = '123e4567-e89b-12d3-a456-426614174000'
const validSessionId = '223e4567-e89b-12d3-a456-426614174001'
const canonicalIds = canonicalizeRendererDiagEvent({
  category: 'error',
  level: 'error',
  event: 'error.renderer',
  workspaceId: validWorkspaceId,
  sessionId: validSessionId,
  traceId: 'tabc123',
  spanId: 'sdef456',
  parentSpanId: 'sparent789',
  name: '[REFERENCE]'
})
assert.equal(canonicalIds?.workspaceId, validWorkspaceId)
assert.equal(canonicalIds?.sessionId, validSessionId)
assert.equal(canonicalIds?.traceId, 'tabc123')
assert.equal(canonicalIds?.spanId, 'sdef456')
assert.equal(canonicalIds?.parentSpanId, 'sparent789')
assert.equal(canonicalIds?.name, null)
const rejectedOpaqueIds = canonicalizeRendererDiagEvent({
  category: 'error',
  level: 'error',
  event: 'error.renderer',
  workspaceId: '[REFERENCE]',
  sessionId: 'valid-session',
  traceId: '[REDACTED]',
  spanId: 'valid-span',
  parentSpanId: '[CIRCULAR]'
})
assert.equal(rejectedOpaqueIds?.workspaceId, null)
assert.equal(rejectedOpaqueIds?.sessionId, null)
assert.equal(rejectedOpaqueIds?.traceId, null)
assert.equal(rejectedOpaqueIds?.spanId, null)
assert.equal(rejectedOpaqueIds?.parentSpanId, null)
const canonicalMain = canonicalizeMainDiagEvent(
  {
    ts: 1,
    process: 'renderer',
    category: 'error',
    level: 'error',
    event: 'error.native',
    workspaceId: validWorkspaceId
  },
  987_654
)
assert.ok(canonicalMain)
assert.equal(canonicalMain.process, 'main')
assert.equal(canonicalMain.ts, 987_654)
assert.equal(
  canonicalizeRendererDiagEvent({
    category: 'error',
    level: 'error',
    event: 'attacker.chosen'
  }),
  null
)
const canonicalTrace = canonicalizeRendererDiagEvent({
  category: 'trace',
  level: 'info',
  event: 'terminal.mount',
  name: 'terminal.mount',
  kind: 'span',
  traceId: 'tcontrol1',
  spanId: 'scontrol1',
  parentSpanId: 'sparent1',
  workspaceId: validWorkspaceId,
  durationMs: Number.POSITIVE_INFINITY
})
assert.ok(canonicalTrace)
assert.equal(canonicalTrace.durationMs, null)
assert.equal(canonicalTrace.name, 'terminal.mount')
assert.equal(
  canonicalizeRendererDiagEvent({
    category: 'trace',
    level: 'info',
    event: 'launch.compose',
    name: 'terminal.mount',
    kind: 'span',
    traceId: 'tcontrol2',
    spanId: 'scontrol2'
  }),
  null
)
assert.equal(
  canonicalizeRendererDiagEvent({
    category: 'trace',
    level: 'info',
    event: 'terminal.mount:surface-created',
    name: 'terminal.mount:surface-created',
    kind: 'mark',
    traceId: 'tcontrol3',
    spanId: 'scontrol3'
  })?.name,
  'terminal.mount:surface-created'
)
assert.equal(
  canonicalizeRendererDiagEvent({
    category: 'trace',
    level: 'info',
    event: 'terminal.mount:surface-reattached',
    name: 'terminal.mount:surface-reattached',
    kind: 'mark',
    traceId: 'tcontrol4',
    spanId: 'scontrol4'
  })?.name,
  'terminal.mount:surface-reattached'
)
assert.equal(
  canonicalizeRendererDiagEvent({
    category: 'trace',
    level: 'info',
    event: 'launch.compose',
    name: 'launch.compose',
    kind: 'span',
    traceId: '[REFERENCE]',
    spanId: 'scontrol5'
  }),
  null
)
assert.equal(
  canonicalizeRendererDiagEvent({
    category: 'trace',
    level: 'info',
    event: 'terminal.mount:opaque-marker',
    name: 'terminal.mount:opaque-marker',
    kind: 'mark',
    traceId: 'tcontrol6',
    spanId: 'scontrol6'
  }),
  null
)

const safeRecord = redactLogRecord({
  message: 'credential=future-string-secret',
  tokenCount: 42
})
assert.doesNotMatch(JSON.stringify(safeRecord), /future-string-secret/)
assert.equal(safeRecord?.['tokenCount'], 42)

setDiagCategoryFlags({
  error: true,
  lifecycle: true,
  perf: true,
  anomaly: true,
  trace: true
})
const capturedEvents: unknown[] = []
const unsubscribe = subscribeDiag((event) => capturedEvents.push(event))
await diag.trace('terminal.mount', { workspaceId: validWorkspaceId }, (span) => {
  span.mark('surface-created')
})
logDiagMain({
  ts: 1,
  process: 'renderer',
  category: 'error',
  level: 'error',
  event: 'error.native',
  message:
    'ORPHEUS_CMD_TOKEN=diag-message-secret --user user:diag-user-secret ' +
    '-H Authorization:diag-header-secret -b diag-cookie-secret',
  data: {
    stack: 'Error: authorization=diag-stack-secret',
    env: { UNRECOGNIZABLE_SECRET_NAME: 'diag-env-secret' }
  }
})
ingestDiagEvent({
  ts: 1,
  process: 'renderer',
  category: 'error',
  level: 'error',
  event: 'error.renderer',
  message: 'credential=renderer-message-secret',
  data: { futureSigningKey: 'renderer-data-secret' }
})
unsubscribe()
const capturedJson = JSON.stringify(capturedEvents)
assert.doesNotMatch(
  capturedJson,
  /diag-message-secret|diag-user-secret|diag-header-secret|diag-cookie-secret|diag-stack-secret|diag-env-secret|renderer-message-secret|renderer-data-secret/
)
assert.match(capturedJson, /error\.native|error\.renderer/)
assert.equal(
  capturedEvents.some(
    (event) =>
      (event as { event?: string; kind?: string }).event === 'terminal.mount:surface-created' &&
      (event as { kind?: string }).kind === 'mark'
  ),
  true,
  'diag.trace terminal.mount surface-created marks must be retained'
)
assert.equal((capturedEvents[0] as { process: string }).process, 'main')
assert.notEqual((capturedEvents[0] as { ts: number }).ts, 1)

const legacySecretValues = [
  'legacy-message-secret',
  'legacy-workspace-secret',
  'legacy-data-secret',
  'legacy-url-password',
  'legacy-query-secret',
  'legacy-user-secret',
  'legacy-proxy-user-secret',
  'legacy-header-secret',
  'legacy-cookie-secret'
]
const legacyRows: unknown[] = [
  {
    id: 7,
    ts: 10,
    seq: 3,
    process: 'main',
    category: 'error',
    level: 'error',
    event: 'error.native',
    workspaceId: `token=${legacySecretValues[1]}`,
    message:
      `https://user:${legacySecretValues[3]}@example.test/path?token=${legacySecretValues[4]} ` +
      `--user user:${legacySecretValues[5]} --proxy-user proxy:${legacySecretValues[6]} ` +
      `-H Authorization:${legacySecretValues[7]} -b ${legacySecretValues[8]}`,
    data: JSON.stringify({
      clientsecret: legacySecretValues[2],
      headers: { 'x-safe': legacySecretValues[0] }
    }),
    traceId: null,
    spanId: null,
    parentSpanId: null,
    name: null,
    kind: null,
    attackerControlledTopLevel: 'legacy-extra-secret'
  },
  {
    id: 8,
    ts: 11,
    seq: 4,
    process: 'attacker',
    category: 'error',
    level: 'error',
    event: 'error.native'
  }
]
const legacyRowsSanitized = sanitizeDiagnosticRowsForOutput(legacyRows)
assert.equal(legacyRowsSanitized.length, 1)
assert.ok(sanitizeDiagnosticRowForOutput(legacyRows[0]))
const legacyJson = JSON.stringify(legacyRowsSanitized)
for (const secret of [...legacySecretValues, 'legacy-extra-secret']) {
  assert.doesNotMatch(legacyJson, new RegExp(secret))
}
assert.equal(
  Object.prototype.hasOwnProperty.call(legacyRowsSanitized[0], 'attackerControlledTopLevel'),
  false
)

const exportDirectory = mkdtempSync(join(tmpdir(), 'orpheus-diag-redaction-'))
try {
  const txtPath = join(exportDirectory, 'diagnostics.txt')
  const jsonPath = join(exportDirectory, 'diagnostics.json')
  const exportResult = writePrivateDiagnosticReportFiles(
    txtPath,
    jsonPath,
    'sanitized diagnostic report',
    legacyRowsSanitized
  )
  assert.deepEqual(exportResult, { ok: true })
  assert.equal(statSync(txtPath).mode & 0o777, 0o600)
  assert.equal(statSync(jsonPath).mode & 0o777, 0o600)
  const exportedJson = readFileSync(jsonPath, 'utf8')
  for (const secret of legacySecretValues) {
    assert.doesNotMatch(exportedJson, new RegExp(secret))
  }
} finally {
  rmSync(exportDirectory, { recursive: true, force: true })
}

const legacyDb = new Database(':memory:')
try {
  legacyDb.exec(`
    CREATE TABLE diagnostics_events (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      process TEXT NOT NULL,
      category TEXT NOT NULL,
      level TEXT NOT NULL,
      event TEXT NOT NULL,
      workspace_id TEXT,
      session_id TEXT,
      duration_ms INTEGER,
      message TEXT,
      data TEXT,
      seq INTEGER NOT NULL,
      trace_id TEXT,
      span_id TEXT,
      parent_span_id TEXT,
      name TEXT,
      kind TEXT
    )
  `)
  legacyDb
    .prepare(
      `INSERT INTO diagnostics_events
       (id, ts, process, category, level, event, workspace_id, session_id,
        duration_ms, message, data, seq, trace_id, span_id, parent_span_id, name, kind)
       VALUES (1, 1, 'main', 'error', 'error', 'error.native',
        'token=stored-workspace-secret', 'safe-session', NULL,
        '--user user:stored-user-secret --proxy-user proxy:stored-proxy-secret -H Authorization:stored-header-secret -b stored-cookie-secret',
        '{"headers":{"x-safe":"stored-header-secret"},"clientSecret":"stored-data-secret"}',
        1, 'safe-trace', 'safe-span', NULL, NULL, NULL)`
    )
    .run()
  const storedRows = legacyDb
    .prepare(
      `SELECT id, ts, process, category, level, event,
              workspace_id AS workspaceId, session_id AS sessionId,
              duration_ms AS durationMs, message, data, seq,
              trace_id AS traceId, span_id AS spanId,
              parent_span_id AS parentSpanId, name, kind
         FROM diagnostics_events ORDER BY id`
    )
    .all()
  assert.equal(legacyDb.prepare('SELECT COUNT(*) AS count FROM diagnostics_events').get()?.count, 1)
  const firstStorage = JSON.stringify(sanitizeDiagnosticRowsForOutput(storedRows))
  assert.doesNotMatch(
    firstStorage,
    /stored-workspace-secret|stored-user-secret|stored-proxy-secret|stored-header-secret|stored-cookie-secret|stored-data-secret/
  )
} finally {
  legacyDb.close()
}

assert.equal(isSafeConsoleBoundaryInstalled(), true)
const safeConsoleArguments = redactConsoleArguments([
  '--user user:console-user-secret --proxy-user proxy:console-proxy-secret ' +
    '-H Authorization:console-header-secret -b console-cookie-secret',
  42,
  true,
  { clientSecret: 'console-object-secret' },
  ...Array.from({ length: 65 }, (_, index) => index)
])
assert.equal(safeConsoleArguments[1], 42)
assert.equal(safeConsoleArguments[2], true)
assert.ok(safeConsoleArguments.length <= 65)
assert.doesNotMatch(
  JSON.stringify(safeConsoleArguments),
  /console-user-secret|console-proxy-secret|console-header-secret|console-cookie-secret|console-object-secret/
)

const trustedFileUrl = 'file:///Applications/Orpheus%20Dev.app/index.html'
assert.equal(isTrustedRendererUrl(`${trustedFileUrl}#route`, trustedFileUrl), true)
assert.equal(
  isTrustedRendererUrl('file:///Applications/Orpheus%20Dev.app/other.html', trustedFileUrl),
  false
)
assert.equal(isTrustedRendererUrl('https://attacker.test/index.html', trustedFileUrl), false)
assert.equal(
  isTrustedRendererUrl('http://localhost:5173/?unexpected=1', 'http://localhost:5173/'),
  false
)

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const nativeSource = readFileSync(`${repositoryRoot}/packages/ghostty-surface/addon.mm`, 'utf8')
assert.doesNotMatch(nativeSource, /env %s=%s/)
assert.match(nativeSource, /env key=%s/)
assert.doesNotMatch(nativeSource, /diag\.message|EXCEPTION: %@/)
assert.doesNotMatch(nativeSource, /ghostty_surface_new threw:/)
assert.match(nativeSource, /E_GHOSTTY_SURFACE_CREATE_EXCEPTION/)

const mainSource = readFileSync(`${repositoryRoot}/src/main/index.ts`, 'utf8')
assert.match(mainSource.slice(0, 200), /import '\.\/safeConsole'/)
const mountLogStart = mainSource.indexOf("'[terminal] mount workspaceId=")
assert.notEqual(mountLogStart, -1)
const mountLog = mainSource.slice(mountLogStart, mountLogStart + 500)
assert.doesNotMatch(mountLog, /flags=%s|settingsJson=%s/)
assert.match(mountLog, /flagsBytes=%d settingsBytes=%d envKeys=%s/)
assert.match(mountLog, /Buffer\.byteLength\(composedLaunch\.flags/)
assert.match(mountLog, /Buffer\.byteLength\(composedLaunch\.settingsJson/)

const systemSource = readFileSync(`${repositoryRoot}/src/main/ipc/system.ts`, 'utf8')
assert.match(systemSource, /sanitizeDiagnosticRowsForOutput/)
assert.match(systemSource, /writePrivateDiagnosticReportFiles/)

const indexSource = readFileSync(`${repositoryRoot}/src/main/index.ts`, 'utf8')
const diagIpcStart = indexSource.indexOf("ipcMain.on('diag:event'")
assert.notEqual(diagIpcStart, -1)
const diagIpcSource = indexSource.slice(diagIpcStart, diagIpcStart + 900)
assert.match(diagIpcSource, /event\.sender\.id !== window\.webContents\.id/)
assert.match(diagIpcSource, /senderFrame !== event\.sender\.mainFrame/)
assert.match(diagIpcSource, /isTrustedRendererUrl\(senderFrame\.url/)
assert.match(diagIpcSource, /isTrustedRendererUrl\(window\.webContents\.getURL\(\)/)
assert.match(diagIpcSource, /evt: unknown/)
assert.match(indexSource, /webContents\.on\('will-navigate'/)
assert.doesNotMatch(indexSource, /\[title\] native fired', \{ workspaceId, raw:/)
assert.match(indexSource, /redactErrorForLog/)

const diagnosticsSource = readFileSync(`${repositoryRoot}/src/main/diagnostics.ts`, 'utf8')
assert.match(diagnosticsSource, /sanitizeDiagnosticRowForOutput/)
assert.doesNotMatch(diagnosticsSource, /sanitizePersistedDiagnostics/)
assert.match(diagnosticsSource, /A malformed event must not prevent later safe rows/)

console.log('log redaction verification passed')
