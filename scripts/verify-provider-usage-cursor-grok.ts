import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { collectCursorUsage } from '../src/main/providerUsage/cursor'
import {
  cursorSessionFromToken,
  parseCursorFallbackUsage,
  parseCursorPrimaryUsage
} from '../src/main/providerUsage/cursorParser'
import {
  collectGrokUsage,
  countGrokAuthCandidates,
  grokClientIdForEntry
} from '../src/main/providerUsage/grok'
import { parseGrokUsage } from '../src/main/providerUsage/parsers'
import type { JsonHttpResult, KeychainReadResult } from '../src/main/providerUsage/runtime'

const FIXED_NOW = Date.parse('2026-07-27T12:00:00.000Z')
const BILLING_START = '2026-07-01T00:00:00.000Z'
const BILLING_END = '2026-08-01T00:00:00.000Z'

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function jsonResult(result: JsonHttpResult): Promise<JsonHttpResult> {
  return Promise.resolve(result)
}

const cursorPrimary = parseCursorPrimaryUsage({
  usage: {
    enabled: true,
    billingCycleStart: Date.parse(BILLING_START),
    billingCycleEnd: Date.parse(BILLING_END),
    planUsage: {
      limit: 10_000,
      remaining: 8_000,
      totalPercentUsed: 20,
      autoPercentUsed: 11,
      apiPercentUsed: 7
    },
    spendLimitUsage: {
      enabled: true,
      individualLimit: 5_000,
      individualRemaining: 1_000
    }
  },
  planName: 'Pro',
  creditGrants: { hasCreditGrants: true, totalCents: 30_000, usedCents: 5_000 },
  stripeBalance: { customerBalance: -25_000 }
})
assert(cursorPrimary)
assert.equal(cursorPrimary.windows.find(({ id }) => id === 'total-usage')?.utilization, 20)
assert.equal(cursorPrimary.windows.find(({ id }) => id === 'auto-usage')?.utilization, 11)
assert.equal(cursorPrimary.windows.find(({ id }) => id === 'api-usage')?.utilization, 7)
assert.equal(cursorPrimary.limits.find(({ id }) => id === 'on-demand')?.displayValue, '$40 / $50')
assert.equal(cursorPrimary.limits.find(({ id }) => id === 'credits')?.displayValue, '$500 left')

const cursorFallback = parseCursorFallbackUsage({
  summary: {
    billingCycleStart: BILLING_START,
    billingCycleEnd: BILLING_END,
    limitType: 'team',
    individualUsage: {
      plan: { autoPercentUsed: 13, apiPercentUsed: 9 },
      onDemand: {
        enabled: true,
        individualLimit: 25_000,
        individualRemaining: 25_000
      }
    },
    teamUsage: {
      pooled: { enabled: true, limit: 100_000, remaining: 50_000 },
      onDemand: { enabled: true, pooledLimit: 10_000, pooledRemaining: 9_000 }
    }
  },
  requestUsage: {
    startOfMonth: BILLING_START,
    'gpt-4': { numRequests: 37, maxRequestUsage: 750 }
  }
})
assert(cursorFallback)
assert.equal(cursorFallback.windows[0]?.utilization, (37 / 750) * 100)
assert.equal(cursorFallback.limits.find(({ id }) => id === 'requests')?.displayValue, '37 / 750')
assert.equal(cursorFallback.limits.find(({ id }) => id === 'on-demand')?.displayValue, '$0 / $250')
assert.equal(cursorFallback.windows[0]?.resetsAt, BILLING_END)

const cursorAccessToken = jwt({
  sub: 'auth0|cursor-user',
  exp: Math.floor((FIXED_NOW + 60 * 60 * 1_000) / 1_000)
})
assert.deepEqual(cursorSessionFromToken(cursorAccessToken), {
  userId: 'cursor-user',
  cookie: `WorkosCursorSessionToken=cursor-user%3A%3A${cursorAccessToken}`
})

const cursorRequests: string[] = []
const cursorCollected = await collectCursorUsage({
  now: () => FIXED_NOW,
  stateDbPath: path.join(os.tmpdir(), 'orpheus-cursor-assertion-missing.vscdb'),
  readKeychain: (service): Promise<KeychainReadResult> =>
    Promise.resolve(
      service === 'cursor-access-token'
        ? { kind: 'found', value: cursorAccessToken }
        : { kind: 'missing' }
    ),
  fetchJson: (url, init): Promise<JsonHttpResult> => {
    assert.equal(init.redirect, 'error')
    cursorRequests.push(url)
    if (url.includes('GetCurrentPeriodUsage')) {
      return jsonResult({
        kind: 'ok',
        status: 200,
        value: {
          enabled: true,
          billingCycleStart: Date.parse(BILLING_START),
          billingCycleEnd: Date.parse(BILLING_END),
          planUsage: { limit: 10_000, remaining: 8_000, totalPercentUsed: 20 }
        }
      })
    }
    if (url.includes('GetPlanInfo')) {
      return jsonResult({ kind: 'ok', status: 200, value: { planInfo: { planName: 'pro' } } })
    }
    if (url.includes('GetCreditGrantsBalance')) {
      return jsonResult({ kind: 'ok', status: 200, value: { hasCreditGrants: false } })
    }
    if (url.endsWith('/api/auth/stripe')) {
      return jsonResult({ kind: 'ok', status: 200, value: { customerBalance: 0 } })
    }
    return jsonResult({ kind: 'unavailable' })
  }
})
assert.equal(cursorCollected.availability, 'available')
assert.equal(cursorCollected.identityLabel, 'Pro')
assert.equal(cursorRequests.length, 4)

const cursorWithoutCredential = await collectCursorUsage({
  stateDbPath: path.join(os.tmpdir(), `orpheus-cursor-no-auth-${process.pid}-${Date.now()}.vscdb`),
  readKeychain: (): Promise<KeychainReadResult> => Promise.resolve({ kind: 'missing' })
})
assert.deepEqual(
  {
    availability: cursorWithoutCredential.availability,
    unavailableReason: cursorWithoutCredential.unavailableReason,
    configured: cursorWithoutCredential.configured
  },
  { availability: 'unavailable', unavailableReason: 'no-auth', configured: false }
)

const cursorWithUnreadableCredential = await collectCursorUsage({
  stateDbPath: path.join(
    os.tmpdir(),
    `orpheus-cursor-unreadable-${process.pid}-${Date.now()}.vscdb`
  ),
  readKeychain: (): Promise<KeychainReadResult> => Promise.resolve({ kind: 'unreadable' })
})
assert.deepEqual(
  {
    availability: cursorWithUnreadableCredential.availability,
    unavailableReason: cursorWithUnreadableCredential.unavailableReason,
    configured: cursorWithUnreadableCredential.configured
  },
  { availability: 'unavailable', unavailableReason: 'error', configured: false }
)

assert.equal(
  countGrokAuthCandidates({
    'first@example.com::client-a': { key: 'first-token' },
    invalid: { refresh_token: 'refresh-only' },
    'second@example.com::client-b': { key: 'second-token' }
  }),
  2
)
assert.equal(grokClientIdForEntry('first@example.com::client-a', {}), 'client-a')
assert.equal(
  grokClientIdForEntry('first@example.com::client-a', { oidc_client_id: 'explicit-client' }),
  'explicit-client'
)

const grokWeekly = parseGrokUsage({
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-07-21T00:00:00.000Z',
      end: '2026-07-28T00:00:00.000Z'
    },
    creditUsagePercent: 25,
    onDemandCap: { val: 2_500 }
  }
})
assert(grokWeekly)
assert.equal(grokWeekly.windows[0]?.utilization, 25)
assert.equal(grokWeekly.limits[0]?.displayValue, '2500 credit cap')
const grokMonthly = parseGrokUsage({
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_MONTHLY',
      start: BILLING_START,
      end: BILLING_END
    },
    creditUsagePercent: 25
  }
})
assert(grokMonthly)
assert.equal(grokMonthly.windows.length, 0)

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orpheus-grok-assertion-'))
try {
  const authPath = path.join(temporaryDirectory, 'auth.json')
  const grokWithoutCredential = await collectGrokUsage({ authPath })
  assert.deepEqual(
    {
      availability: grokWithoutCredential.availability,
      unavailableReason: grokWithoutCredential.unavailableReason,
      configured: grokWithoutCredential.configured
    },
    { availability: 'unavailable', unavailableReason: 'no-auth', configured: false }
  )

  fs.writeFileSync(authPath, '{"invalid":')
  const grokWithInvalidCredential = await collectGrokUsage({ authPath })
  assert.deepEqual(
    {
      availability: grokWithInvalidCredential.availability,
      unavailableReason: grokWithInvalidCredential.unavailableReason,
      configured: grokWithInvalidCredential.configured
    },
    { availability: 'unavailable', unavailableReason: 'error', configured: true }
  )

  const untouchedAccount = {
    key: 'untouched-token',
    refresh_token: 'untouched-refresh',
    custom_other: { preserve: true }
  }
  fs.writeFileSync(
    authPath,
    `${JSON.stringify(
      {
        'first@example.com::client-a': {
          key: 'expired-token',
          refresh_token: 'first-refresh',
          expires_at: '2026-07-27T11:00:00.000Z',
          custom_field: 'keep-me'
        },
        'second@example.com::client-b': untouchedAccount,
        root_custom_field: { preserve: 'also' }
      },
      null,
      2
    )}\n`,
    { mode: 0o640 }
  )
  fs.chmodSync(authPath, 0o640)

  const grokRequests: string[] = []
  const grokCollected = await collectGrokUsage({
    authPath,
    now: () => FIXED_NOW,
    fetchJson: (url, init): Promise<JsonHttpResult> => {
      assert.equal(init.redirect, 'error')
      grokRequests.push(url)
      if (url.includes('/oauth2/token')) {
        return jsonResult({
          kind: 'ok',
          status: 200,
          value: {
            access_token: 'refreshed-token',
            refresh_token: 'rotated-refresh',
            id_token: 'new-id-token',
            expires_in: 3_600
          }
        })
      }
      if (url.includes('/v1/billing')) {
        return jsonResult({
          kind: 'ok',
          status: 200,
          value: {
            config: {
              currentPeriod: {
                type: 'USAGE_PERIOD_TYPE_WEEKLY',
                start: '2026-07-21T00:00:00.000Z',
                end: '2026-07-28T00:00:00.000Z'
              },
              creditUsagePercent: 25,
              onDemandCap: { val: 2_500 }
            }
          }
        })
      }
      if (url.endsWith('/v1/settings')) {
        return jsonResult({
          kind: 'ok',
          status: 200,
          value: { subscription_tier_display: 'SuperGrok' }
        })
      }
      return jsonResult({ kind: 'unavailable' })
    }
  })
  assert.equal(grokCollected.availability, 'available')
  assert.equal(grokCollected.identityLabel, 'first@example.com')
  assert.equal(grokRequests.length, 3)
  assert.equal(fs.statSync(authPath).mode & 0o777, 0o640)

  const persisted = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<
    string,
    Record<string, unknown>
  >
  assert.equal(persisted['first@example.com::client-a']?.['key'], 'refreshed-token')
  assert.equal(persisted['first@example.com::client-a']?.['refresh_token'], 'rotated-refresh')
  assert.equal(persisted['first@example.com::client-a']?.['custom_field'], 'keep-me')
  assert.deepEqual(persisted['second@example.com::client-b'], untouchedAccount)
  assert.deepEqual(persisted['root_custom_field'], { preserve: 'also' })
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}

console.log('Cursor and Grok provider usage assertions passed.')
