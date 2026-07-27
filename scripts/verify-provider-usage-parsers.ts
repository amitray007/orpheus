import assert from 'node:assert/strict'
import {
  buildAntigravityPoolWindows,
  parseAntigravityCredential,
  parseAntigravityQuotaSummary,
  parseListeningPorts,
  rankLanguageServerCandidates,
  refreshAntigravityCloudWithCli,
  resolveAntigravityCliExecutable
} from '../src/main/providerUsage/antigravity'
import {
  parseCopilotOrgLogins,
  parseCopilotOrgUsage,
  parseGithubDotComYamlCredential
} from '../src/main/providerUsage/copilot'
import {
  cursorSessionFromToken,
  parseCursorFallbackUsage,
  parseCursorPrimaryUsage
} from '../src/main/providerUsage/cursorParser'
import {
  countGrokAuthCandidates,
  grokClientIdForEntry,
  grokTokenExpirationMs
} from '../src/main/providerUsage/grok'
import { parseCopilotUsage, parseGrokUsage } from '../src/main/providerUsage/parsers'
import { unwrapGoKeyring } from '../src/main/providerUsage/runtime'

const cursorCycleStart = Date.parse('2026-07-01T00:00:00Z')
const cursorCycleEnd = Date.parse('2026-08-01T00:00:00Z')
const cursor = parseCursorPrimaryUsage({
  usage: {
    enabled: true,
    billingCycleStart: cursorCycleStart,
    billingCycleEnd: cursorCycleEnd,
    planUsage: {
      limit: 10_000,
      remaining: 2_500,
      totalSpend: 7_500,
      totalPercentUsed: 75,
      autoPercentUsed: 40,
      apiPercentUsed: 20
    },
    spendLimitUsage: {
      enabled: true,
      individualLimit: 5_000,
      individualRemaining: 3_500,
      individualUsed: 1_500
    }
  },
  planName: 'Pro',
  creditGrants: {
    hasCreditGrants: true,
    totalCents: 3_000,
    usedCents: 500
  },
  stripeBalance: { customerBalance: -1_000 }
})
assert.deepEqual(
  cursor?.windows.map(({ id, utilization, resetsAt, durationMinutes }) => ({
    id,
    utilization,
    resetsAt,
    durationMinutes
  })),
  [
    {
      id: 'total-usage',
      utilization: 75,
      resetsAt: '2026-08-01T00:00:00.000Z',
      durationMinutes: 44_640
    },
    {
      id: 'auto-usage',
      utilization: 40,
      resetsAt: '2026-08-01T00:00:00.000Z',
      durationMinutes: 44_640
    },
    {
      id: 'api-usage',
      utilization: 20,
      resetsAt: '2026-08-01T00:00:00.000Z',
      durationMinutes: 44_640
    }
  ]
)
assert.deepEqual(
  cursor?.limits.map(({ id, displayValue, utilization }) => ({ id, displayValue, utilization })),
  [
    { id: 'credits', displayValue: '$35 left', utilization: null },
    { id: 'on-demand', displayValue: '$15 / $50', utilization: 30 }
  ]
)

const cursorFallback = parseCursorFallbackUsage({
  summary: null,
  requestUsage: {
    startOfMonth: '2026-07-01T00:00:00Z',
    'gpt-4': { maxRequestUsage: 500, numRequests: 125 }
  }
})
assert.deepEqual(
  cursorFallback?.windows.map(({ id, utilization }) => ({ id, utilization })),
  [{ id: 'total-usage', utilization: 25 }]
)
assert.equal(cursorFallback?.limits[0]?.displayValue, '125 / 500')

const cursorFixturePayload = Buffer.from(
  JSON.stringify({ sub: 'auth0|fixture-cursor-user', exp: 1_800_000_000 }),
  'utf8'
).toString('base64url')
assert.deepEqual(
  cursorSessionFromToken(`fixture.${cursorFixturePayload}.signature`)?.userId,
  'fixture-cursor-user'
)
assert.equal(cursorSessionFromToken('malformed-token'), null)

const grok = parseGrokUsage({
  config: {
    creditUsagePercent: 37.5,
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-07-03T00:00:00Z',
      end: '2026-07-10T00:00:00Z'
    },
    onDemandCap: { val: 2_500 }
  }
})
assert.deepEqual(
  grok?.windows.map(({ id, utilization, resetsAt, durationMinutes }) => ({
    id,
    utilization,
    resetsAt,
    durationMinutes
  })),
  [
    {
      id: 'weekly',
      utilization: 37.5,
      resetsAt: '2026-07-10T00:00:00.000Z',
      durationMinutes: 10_080
    }
  ]
)
assert.equal(grok?.limits[0]?.displayValue, '2500 credit cap')
assert.equal(
  parseGrokUsage({
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-07-03T00:00:00Z',
        end: '2026-07-10T00:00:00Z'
      }
    }
  })?.windows[0]?.utilization,
  0
)
assert.equal(
  parseGrokUsage({
    config: {
      creditUsagePercent: 'not-a-number',
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-07-03T00:00:00Z',
        end: '2026-07-10T00:00:00Z'
      }
    }
  }),
  null
)
assert.equal(
  countGrokAuthCandidates({
    'fixture@example.test::fixture-client': { key: 'fixture-access-token' },
    invalid: {}
  }),
  1
)
assert.equal(grokClientIdForEntry('fixture@example.test::fixture-client', {}), 'fixture-client')
const grokFixturePayload = Buffer.from(JSON.stringify({ exp: 1_800_000_000 }), 'utf8').toString(
  'base64url'
)
assert.equal(grokTokenExpirationMs(`fixture.${grokFixturePayload}.signature`), 1_800_000_000_000)

const encodedCredential = Buffer.from(
  JSON.stringify({
    token: {
      access_token: 'fixture-access-token',
      refresh_token: 'fixture-refresh-token',
      expiry: '2026-08-01T12:00:00Z'
    }
  }),
  'utf8'
).toString('base64')
assert.deepEqual(parseAntigravityCredential(`go-keyring-base64:${encodedCredential}`), {
  accessToken: 'fixture-access-token',
  refreshToken: 'fixture-refresh-token',
  expiry: '2026-08-01T12:00:00.000Z'
})
assert.equal(unwrapGoKeyring('go-keyring-base64:not-valid-base64'), null)
assert.equal(parseAntigravityCredential('{"token":'), null)

const executableFixtures = new Set(['/fixture/path/bin/agy'])
assert.equal(
  resolveAntigravityCliExecutable({
    pathValue: '/fixture/missing:/fixture/path/bin',
    homeDirectory: '/fixture/home',
    isExecutable: (candidate) => executableFixtures.has(candidate)
  }),
  '/fixture/path/bin/agy'
)
assert.equal(
  resolveAntigravityCliExecutable({
    pathValue: 'relative/bin',
    homeDirectory: '/fixture/home',
    isExecutable: (candidate) => candidate === '/fixture/home/.local/bin/agy'
  }),
  '/fixture/home/.local/bin/agy'
)

const refreshCommands: Array<{ executable: string; args: string[] }> = []
let cloudRetryCount = 0
const refreshedCloud = await refreshAntigravityCloudWithCli({
  executable: '/fixture/path/bin/agy',
  runCli: async (executable, args) => {
    refreshCommands.push({ executable, args })
    return true
  },
  rereadCredential: async () => ({
    accessToken: 'fixture-refreshed-access-token',
    refreshToken: 'fixture-refresh-token',
    expiry: '2099-08-01T12:00:00.000Z'
  }),
  retryCloud: async (accessToken) => {
    cloudRetryCount += 1
    assert.equal(accessToken, 'fixture-refreshed-access-token')
    return {
      kind: 'success',
      result: { windows: [], plan: 'Pro', authoritative: true }
    }
  }
})
assert.equal(refreshedCloud.kind, 'success')
assert.deepEqual(refreshCommands, [{ executable: '/fixture/path/bin/agy', args: ['models'] }])
assert.equal(cloudRetryCount, 1)

let rereadAfterFailedCommand = false
const failedCliRefresh = await refreshAntigravityCloudWithCli({
  executable: '/fixture/path/bin/agy',
  runCli: async () => false,
  rereadCredential: async () => {
    rereadAfterFailedCommand = true
    return null
  },
  retryCloud: async () => {
    throw new Error('Cloud retry must not run after a failed CLI refresh')
  }
})
assert.equal(failedCliRefresh.kind, 'unavailable')
assert.equal(rereadAfterFailedCommand, true)

const summary = parseAntigravityQuotaSummary({
  response: {
    groups: [
      {
        buckets: [
          {
            bucketId: 'gemini-5h',
            remainingFraction: 0.75,
            resetTime: '2026-08-01T12:00:00Z'
          },
          { bucketId: 'gemini-weekly', remainingFraction: 0.2 },
          { bucketId: '3p-5h', remainingFraction: 1 },
          { bucketId: '3p-weekly' },
          { bucketId: 'future-bucket', remainingFraction: 0 }
        ]
      }
    ]
  }
})
assert.deepEqual(
  summary?.windows.map(({ id, utilization }) => ({ id, utilization })),
  [
    { id: 'gemini-5h', utilization: 25 },
    { id: 'gemini-weekly', utilization: 80 },
    { id: '3p-5h', utilization: 0 }
  ]
)
assert.deepEqual(parseAntigravityQuotaSummary({ response: {}, groups: [] }), {
  windows: [],
  plan: null,
  authoritative: true
})

const pooled = buildAntigravityPoolWindows([
  {
    label: 'Gemini 3 Pro (High)',
    modelId: 'gemini-3-pro',
    remainingFraction: 0.8,
    resetsAt: null
  },
  {
    label: 'Gemini 3 Flash',
    modelId: 'gemini-3-flash',
    remainingFraction: 0.35,
    resetsAt: null
  },
  {
    label: 'Claude Sonnet',
    modelId: 'claude-sonnet',
    remainingFraction: 0.6,
    resetsAt: null
  },
  {
    label: 'Blacklisted duplicate',
    modelId: 'MODEL_CHAT_20706',
    remainingFraction: 0,
    resetsAt: null
  }
])
assert.deepEqual(
  pooled.map(({ id, utilization }) => ({ id, utilization })),
  [
    { id: 'gemini-5h', utilization: 65 },
    { id: '3p-5h', utilization: 40 }
  ]
)

const ranked = rankLanguageServerCandidates(
  [
    '  101 /Applications/Foo/language_server --ide_name antigravity-next --csrf_token wrong',
    '  202 /Applications/Antigravity/language_server --ide_name antigravity --csrf_token right',
    '  303 /Applications/antigravity/language_server --csrf_token fallback'
  ].join('\n'),
  {
    processName: 'language_server',
    markers: ['antigravity', 'antigravity-ide'],
    csrfFlag: '--csrf_token',
    portFlag: '--extension_server_port'
  }
)
assert.deepEqual(
  ranked.map(({ pid }) => pid),
  [202, 303]
)
assert.deepEqual(
  parseListeningPorts(
    [
      'language_ 202 user 12u IPv4 TCP 127.0.0.1:52168 (LISTEN)',
      'language_ 202 user 13u IPv6 TCP [::1]:52168 (LISTEN)',
      'language_ 202 user 14u IPv4 TCP 127.0.0.1:52170 (LISTEN)'
    ].join('\n')
  ),
  [52168, 52170]
)

assert.deepEqual(
  parseGithubDotComYamlCredential(`
github.example.com:
  user: enterprise-user
  oauth_token: enterprise-secret
github.com:
  user: public-user
  oauth_token: public-token
`),
  { token: 'public-token', identityLabel: 'public-user' }
)

const copilot = parseCopilotUsage({
  copilot_plan: 'business',
  quota_reset_date: '2026-08-01T00:00:00Z',
  quota_snapshots: {
    premium_interactions: {
      entitlement: 100,
      remaining: 25,
      percent_remaining: 25,
      overage_permitted: 'true'
    },
    chat: { unlimited: 'true', entitlement: 50, remaining: 50 },
    completions: { entitlement: 0, remaining: 0 }
  }
})
assert.deepEqual(
  copilot?.windows.map(({ id, utilization }) => ({ id, utilization })),
  [{ id: 'premium-interactions', utilization: 75 }]
)
assert.equal(copilot?.limits[0]?.displayValue, '0')
assert.deepEqual(
  parseCopilotOrgLogins([{ login: 'first' }, { login: '' }, {}, { login: 'second' }]),
  ['first', 'second']
)
assert.deepEqual(
  parseCopilotOrgUsage({
    usageItems: [
      {
        product: 'Copilot',
        unitType: 'ai-credits',
        grossQuantity: 3.5,
        netAmount: 1.5
      },
      {
        product: 'copilot',
        unitType: 'seat',
        grossQuantity: 99,
        netAmount: 99
      }
    ]
  })?.map(({ id, displayValue }) => ({ id, displayValue })),
  [
    { id: 'org-credits', displayValue: '3.5' },
    { id: 'org-spend', displayValue: '$1.50' }
  ]
)

console.log('provider usage parser fixtures passed')
