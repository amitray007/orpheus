// ---------------------------------------------------------------------------
// scripts/verify-oauth.ts
//
// Assertion harness for the in-app OAuth "Connect <provider>" flow
// (model-routing unit 07): src/main/routingProxy/oauth.ts. Mirrors the
// existing scripts/verify-*.ts convention: run via `bun run` (the
// `test:oauth` package script), no test framework.
//
// MUST PASS FULLY OFFLINE. oauth.ts takes every external effect (HTTP,
// isRunning(), getManagementSecret()) via an injectable OAuthDeps object —
// nothing here makes a real network call, spawns a process, or touches
// Electron. shell.openExternal lives in manager.ts (the real IPC call site),
// not oauth.ts, specifically so this module stays Electron-free.
//
// Covers (per the unit spec):
//   - auth-url path always includes is_webui=true, for every OAuth-eligible
//     provider descriptor
//   - only OAuth-capable descriptors are offered (gemini NOT offered)
//   - pollAuthStatus maps ok/wait/error correctly
//   - pollUntilSettled terminates on 'ok', tolerates 'wait', respects the
//     timeout, and terminates the whole poll on a 401 (no retry)
//   - a 401 is EXACTLY one attempt — no retry — both at startProviderLogin
//     and inside pollUntilSettled
//   - transient (non-401) errors are tolerated up to the threshold, then fail
//   - cancelProviderLogin issues a DELETE with the correct state
//   - startProviderLogin refuses with a clear error when the proxy isn't
//     running / has no management secret, without ever attempting a fetch
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  isOAuthEligible,
  eligibleOAuthProviderIds,
  startProviderLogin,
  pollAuthStatus,
  pollUntilSettled,
  cancelProviderLogin,
  OAuthLoginRefusedError,
  OAuthUnauthorizedError,
  type OAuthDeps
} from '../src/main/routingProxy/oauth.ts'
import { PROVIDERS, getProviderDescriptor } from '../src/main/routingProxy/providers/registry.ts'

const BASE_URL = 'http://127.0.0.1:18765'

function runningDeps(overrides: Partial<OAuthDeps> = {}): OAuthDeps {
  return {
    fetchJsonWithStatus: async () => {
      throw new Error('fetchJsonWithStatus called without an override — test bug')
    },
    isRunning: () => true,
    getManagementSecret: () => 'fake-management-secret',
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 1. Eligibility — derived from descriptors. (model-routing unit 09-polish:
//    PROVIDERS was trimmed to exactly codex/xai/antigravity/ollama — gemini
//    and kimi were REMOVED entirely, not just made oauth-ineligible, so the
//    old "gemini descriptor still exists but isn't oauth-eligible" case no
//    longer applies; ollama takes over as the "a real, still-registered,
//    non-oauth-eligible descriptor" example instead.)
// ---------------------------------------------------------------------------

{
  const eligible = eligibleOAuthProviderIds()
  assert.ok(eligible.length > 0, 'at least one provider must be OAuth-eligible')
  assert.ok(
    !eligible.includes('gemini'),
    'gemini must never be offered a Connect button (it is not even a registered provider anymore)'
  )
  assert.equal(
    getProviderDescriptor('gemini'),
    null,
    '(unit 09-polish) gemini must no longer resolve to a descriptor at all — it was removed from PROVIDERS'
  )
  assert.equal(
    getProviderDescriptor('kimi'),
    null,
    '(unit 09-polish) kimi must no longer resolve to a descriptor at all — it was removed from PROVIDERS'
  )
  assert.deepEqual(
    new Set(eligible),
    new Set(['codex', 'xai', 'antigravity']),
    '(unit 09-polish) OAuth-eligible providers must be exactly codex/xai/antigravity — the trimmed PROVIDERS list'
  )

  const ollamaDescriptor = getProviderDescriptor('ollama')
  assert.ok(ollamaDescriptor, 'ollama descriptor must still exist (openaiCompatible-only)')
  assert.equal(
    isOAuthEligible(ollamaDescriptor!),
    false,
    'ollama descriptor must not claim oauth in authMethods'
  )
  assert.equal(
    ollamaDescriptor!.authMethods.includes('oauth'),
    false,
    'ollama authMethods must not include oauth'
  )

  // Every OAuth-eligible descriptor really is present in PROVIDERS and
  // structurally consistent (mirrors verify-providers.ts's own check).
  for (const id of eligible) {
    const d = PROVIDERS.find((p) => p.id === id)
    assert.ok(d, `${id} must resolve to a real descriptor`)
    assert.ok(d!.authMethods.includes('oauth'), `${id} must declare oauth in authMethods`)
  }

  console.log(
    '✓ (unit 09-polish) eligibility is derived purely from descriptors; gemini/kimi no longer resolve at ' +
      'all (removed from PROVIDERS); eligible set is exactly codex/xai/antigravity'
  )
}

// ---------------------------------------------------------------------------
// 2. startProviderLogin — auth-url path always includes is_webui=true, for
//    EVERY OAuth-eligible provider (not just one hardcoded example).
// ---------------------------------------------------------------------------

{
  for (const providerId of eligibleOAuthProviderIds()) {
    let capturedUrl: string | null = null
    const deps = runningDeps({
      fetchJsonWithStatus: async (url) => {
        capturedUrl = url
        return {
          status: 200,
          body: { status: 'ok', url: 'https://provider.example/authorize', state: 'state-abc' }
        }
      }
    })
    const result = await startProviderLogin(providerId, BASE_URL, deps)
    assert.ok(capturedUrl, `${providerId}: fetch must have been called`)
    const parsed = new URL(capturedUrl!)
    assert.equal(
      parsed.pathname,
      `/v0/management/${providerId}-auth-url`,
      `${providerId}: must hit the provider-specific auth-url route`
    )
    assert.equal(
      parsed.searchParams.get('is_webui'),
      'true',
      `${providerId}: auth-url call must always include is_webui=true`
    )
    assert.equal(result.url, 'https://provider.example/authorize')
    assert.equal(result.state, 'state-abc')
  }
  console.log('✓ startProviderLogin always sends is_webui=true, for every OAuth-eligible provider')
}

// ---------------------------------------------------------------------------
// 3. startProviderLogin parses device-flow fields when present.
// ---------------------------------------------------------------------------

{
  const deps = runningDeps({
    fetchJsonWithStatus: async () => ({
      status: 200,
      body: {
        status: 'ok',
        url: 'https://provider.example/device',
        state: 'state-device',
        flow: 'device',
        user_code: 'ABCD-1234',
        expires_in: 1800
      }
    })
  })
  // Uses 'antigravity' (unit 09-polish: 'kimi' was removed from PROVIDERS,
  // this only needs any real oauth-eligible provider id to exercise the
  // device-flow field parsing, which is provider-agnostic).
  const result = await startProviderLogin('antigravity', BASE_URL, deps)
  assert.equal(result.flow, 'device')
  assert.equal(result.userCode, 'ABCD-1234')
  assert.equal(result.expiresIn, 1800)
  console.log('✓ startProviderLogin parses device-flow fields (flow/user_code/expires_in)')
}

// ---------------------------------------------------------------------------
// 4. startProviderLogin refuses cleanly — never hangs, never fetches — when
//    the provider is ineligible, the proxy isn't running, or there's no
//    management secret.
// ---------------------------------------------------------------------------

{
  await assert.rejects(
    () => startProviderLogin('ollama', BASE_URL, runningDeps()),
    OAuthLoginRefusedError,
    '(unit 09-polish) ollama (registered, but not oauth-eligible) must be refused'
  )
  await assert.rejects(
    () => startProviderLogin('gemini', BASE_URL, runningDeps()),
    OAuthLoginRefusedError,
    '(unit 09-polish) gemini (no longer a registered provider at all) must also be refused'
  )
  await assert.rejects(
    () => startProviderLogin('not-a-real-provider', BASE_URL, runningDeps()),
    OAuthLoginRefusedError,
    'an unknown provider id must be refused'
  )

  let fetchCalledWhileNotRunning = false
  await assert.rejects(
    () =>
      startProviderLogin(
        'codex',
        BASE_URL,
        runningDeps({
          isRunning: () => false,
          fetchJsonWithStatus: async () => {
            fetchCalledWhileNotRunning = true
            return { status: 200, body: {} }
          }
        })
      ),
    OAuthLoginRefusedError,
    'proxy not running must be refused'
  )
  assert.equal(
    fetchCalledWhileNotRunning,
    false,
    'refusing because the proxy is not running must skip the network entirely (never hang waiting on a dead process)'
  )

  let fetchCalledWithNoSecret = false
  await assert.rejects(
    () =>
      startProviderLogin(
        'codex',
        BASE_URL,
        runningDeps({
          getManagementSecret: () => null,
          fetchJsonWithStatus: async () => {
            fetchCalledWithNoSecret = true
            return { status: 200, body: {} }
          }
        })
      ),
    OAuthLoginRefusedError,
    'no management secret must be refused'
  )
  assert.equal(fetchCalledWithNoSecret, false, 'no secret must also skip the network entirely')

  console.log(
    '✓ startProviderLogin refuses with a clear error (ineligible provider / proxy not running / no secret) and never hangs'
  )
}

// ---------------------------------------------------------------------------
// 5. startProviderLogin — a 401 fails immediately, exactly one attempt.
// ---------------------------------------------------------------------------

{
  let callCount = 0
  const deps = runningDeps({
    fetchJsonWithStatus: async () => {
      callCount += 1
      return { status: 401, body: { error: 'unauthorized' } }
    }
  })
  await assert.rejects(
    () => startProviderLogin('codex', BASE_URL, deps),
    OAuthUnauthorizedError,
    'a 401 starting login must throw OAuthUnauthorizedError'
  )
  assert.equal(callCount, 1, 'a 401 must result in EXACTLY one fetch attempt, never retried')
  console.log('✓ startProviderLogin: a 401 fails immediately with exactly one attempt, no retry')
}

// ---------------------------------------------------------------------------
// 6. pollAuthStatus — maps ok/wait/error correctly, and a malformed/unknown
//    status string safely degrades to 'error' rather than crashing.
// ---------------------------------------------------------------------------

{
  const okDeps = runningDeps({
    fetchJsonWithStatus: async () => ({ status: 200, body: { status: 'ok' } })
  })
  assert.equal((await pollAuthStatus('s1', BASE_URL, okDeps)).status, 'ok')

  const waitDeps = runningDeps({
    fetchJsonWithStatus: async () => ({ status: 200, body: { status: 'wait' } })
  })
  assert.equal((await pollAuthStatus('s1', BASE_URL, waitDeps)).status, 'wait')

  const errorDeps = runningDeps({
    fetchJsonWithStatus: async () => ({
      status: 200,
      body: { status: 'error', error: 'user denied access' }
    })
  })
  const errorResult = await pollAuthStatus('s1', BASE_URL, errorDeps)
  assert.equal(errorResult.status, 'error')
  assert.equal(errorResult.error, 'user denied access')

  const malformedDeps = runningDeps({
    fetchJsonWithStatus: async () => ({ status: 200, body: { status: 'something-unexpected' } })
  })
  assert.equal(
    (await pollAuthStatus('s1', BASE_URL, malformedDeps)).status,
    'error',
    'an unrecognized status string must safely degrade to error, never crash or silently pass'
  )

  // Correct state param.
  let capturedUrl: string | null = null
  await pollAuthStatus(
    'state-xyz',
    BASE_URL,
    runningDeps({
      fetchJsonWithStatus: async (url) => {
        capturedUrl = url
        return { status: 200, body: { status: 'ok' } }
      }
    })
  )
  assert.equal(new URL(capturedUrl!).searchParams.get('state'), 'state-xyz')
  assert.equal(new URL(capturedUrl!).pathname, '/v0/management/get-auth-status')

  console.log(
    '✓ pollAuthStatus maps ok/wait/error correctly, degrades unknown strings to error, sends the right state param'
  )
}

// ---------------------------------------------------------------------------
// 7. pollAuthStatus — a 401 throws OAuthUnauthorizedError, single attempt.
// ---------------------------------------------------------------------------

{
  let callCount = 0
  const deps = runningDeps({
    fetchJsonWithStatus: async () => {
      callCount += 1
      return { status: 401, body: {} }
    }
  })
  await assert.rejects(() => pollAuthStatus('s1', BASE_URL, deps), OAuthUnauthorizedError)
  assert.equal(callCount, 1, 'pollAuthStatus itself never retries a 401')
  console.log('✓ pollAuthStatus: a 401 throws immediately, exactly one attempt')
}

// ---------------------------------------------------------------------------
// 8. pollUntilSettled — terminates on 'ok' without waiting out the timeout.
// ---------------------------------------------------------------------------

{
  let pollCount = 0
  let slept = 0
  const deps = runningDeps({
    fetchJsonWithStatus: async () => {
      pollCount += 1
      return { status: 200, body: { status: pollCount >= 3 ? 'ok' : 'wait' } }
    }
  })
  const result = await pollUntilSettled('s1', BASE_URL, deps, {
    sleep: async () => {
      slept += 1
    },
    now: () => 0 // frozen clock — deadline math still works, no real timeout risk
  })
  assert.deepEqual(result, { outcome: 'ok' })
  assert.equal(pollCount, 3, 'must have polled exactly 3 times before settling ok')
  assert.equal(slept, 2, 'must have slept between polls, not after the final settling one')
  console.log("✓ pollUntilSettled terminates on 'ok' after tolerating 'wait' responses")
}

// ---------------------------------------------------------------------------
// 9. pollUntilSettled — terminates on 'error' immediately (not a timeout).
// ---------------------------------------------------------------------------

{
  const deps = runningDeps({
    fetchJsonWithStatus: async () => ({
      status: 200,
      body: { status: 'error', error: 'access_denied' }
    })
  })
  const result = await pollUntilSettled('s1', BASE_URL, deps, {
    sleep: async () => {
      throw new Error('must not sleep — should terminate on the very first poll')
    }
  })
  assert.deepEqual(result, { outcome: 'error', error: 'access_denied' })
  console.log("✓ pollUntilSettled terminates immediately on 'error', no sleep/retry")
}

// ---------------------------------------------------------------------------
// 10. pollUntilSettled — respects the timeout (device-flow expiresInSec AND
//     the plain timeoutMs/defaultTimeoutMs path), using a simulated clock so
//     the test takes zero real wall-clock time.
// ---------------------------------------------------------------------------

{
  let simulatedNow = 0
  const deps = runningDeps({
    fetchJsonWithStatus: async () => ({ status: 200, body: { status: 'wait' } })
  })
  const result = await pollUntilSettled('s1', BASE_URL, deps, {
    intervalMs: 2000,
    expiresInSec: 5, // 5s deadline, 2s interval -> times out after ~2-3 polls
    now: () => simulatedNow,
    sleep: async (ms) => {
      simulatedNow += ms
    }
  })
  assert.deepEqual(result, { outcome: 'timeout' })
  console.log('✓ pollUntilSettled respects expiresInSec (device-flow) and times out cleanly')

  // Plain timeoutMs path (interactive default), also simulated.
  simulatedNow = 0
  const result2 = await pollUntilSettled('s1', BASE_URL, deps, {
    intervalMs: 2000,
    timeoutMs: 10_000,
    now: () => simulatedNow,
    sleep: async (ms) => {
      simulatedNow += ms
    }
  })
  assert.deepEqual(result2, { outcome: 'timeout' })
  console.log('✓ pollUntilSettled respects an explicit timeoutMs the same way')
}

// ---------------------------------------------------------------------------
// 11. pollUntilSettled — a 401 mid-poll terminates the WHOLE loop immediately
//     as 'unauthorized', with exactly the one attempt that produced it — even
//     if earlier polls had already accumulated transient errors.
// ---------------------------------------------------------------------------

{
  let callCount = 0
  const deps = runningDeps({
    fetchJsonWithStatus: async () => {
      callCount += 1
      if (callCount <= 2) throw new Error('transient network blip')
      if (callCount === 3) return { status: 401, body: {} }
      throw new Error('must not be called again after a 401')
    }
  })
  const result = await pollUntilSettled('s1', BASE_URL, deps, {
    sleep: async () => {},
    now: () => 0
  })
  assert.deepEqual(result, { outcome: 'unauthorized' })
  assert.equal(callCount, 3, 'must stop at exactly the 401 call — never call again afterward')
  console.log(
    '✓ pollUntilSettled: a 401 mid-poll terminates immediately as unauthorized, never retried, regardless of prior transient errors'
  )
}

// ---------------------------------------------------------------------------
// 12. pollUntilSettled — transient (non-401) errors are tolerated up to the
//     threshold, then the whole poll fails; but a working poll AFTER some
//     transient errors still succeeds (the counter resets on success).
// ---------------------------------------------------------------------------

{
  // Exactly at the threshold: default maxTransientErrors=5, poll succeeds on
  // attempt 5 having failed the first 4 (well under fail-the-whole-thing).
  let callCount = 0
  const recoveringDeps = runningDeps({
    fetchJsonWithStatus: async () => {
      callCount += 1
      if (callCount <= 4) throw new Error('flaky')
      return { status: 200, body: { status: 'ok' } }
    }
  })
  const recovered = await pollUntilSettled('s1', BASE_URL, recoveringDeps, {
    sleep: async () => {},
    now: () => 0,
    maxTransientErrors: 5
  })
  assert.deepEqual(recovered, { outcome: 'ok' })
  console.log('✓ pollUntilSettled tolerates transient errors under the threshold, then succeeds')

  // Over the threshold: every call fails with a transient (non-401) error;
  // the whole poll must fail with 'error', not hang or throw uncaught.
  let callCount2 = 0
  const alwaysFailingDeps = runningDeps({
    fetchJsonWithStatus: async () => {
      callCount2 += 1
      throw new Error('permanently flaky')
    }
  })
  const failed = await pollUntilSettled('s1', BASE_URL, alwaysFailingDeps, {
    sleep: async () => {},
    now: () => 0,
    maxTransientErrors: 3
  })
  assert.equal(failed.outcome, 'error')
  assert.equal(
    callCount2,
    4,
    'must attempt maxTransientErrors + 1 times before giving up (3 tolerated, 4th fails the loop)'
  )
  console.log(
    '✓ pollUntilSettled fails the whole poll after exceeding the transient-error threshold, without hanging'
  )
}

// ---------------------------------------------------------------------------
// 13. cancelProviderLogin — issues a DELETE with the correct state, is
//     best-effort (never throws even if the request fails), and no-ops
//     without a management secret.
// ---------------------------------------------------------------------------

{
  let capturedUrl: string | null = null
  let capturedMethod: string | undefined
  await cancelProviderLogin(
    'state-to-cancel',
    BASE_URL,
    runningDeps({
      fetchJsonWithStatus: async (url, init) => {
        capturedUrl = url
        capturedMethod = init.method
        return { status: 200, body: { status: 'ok' } }
      }
    })
  )
  assert.equal(capturedMethod, 'DELETE')
  const parsed = new URL(capturedUrl!)
  assert.equal(parsed.pathname, '/v0/management/oauth-session')
  assert.equal(parsed.searchParams.get('state'), 'state-to-cancel')
  console.log(
    '✓ cancelProviderLogin issues DELETE /v0/management/oauth-session with the correct state'
  )

  // Best-effort: a failing DELETE must not throw.
  await cancelProviderLogin(
    's1',
    BASE_URL,
    runningDeps({
      fetchJsonWithStatus: async () => {
        throw new Error('network error')
      }
    })
  )
  console.log('✓ cancelProviderLogin never throws, even when the DELETE request fails')

  // No secret -> no-op, no fetch attempted.
  let fetchCalled = false
  await cancelProviderLogin(
    's1',
    BASE_URL,
    runningDeps({
      getManagementSecret: () => null,
      fetchJsonWithStatus: async () => {
        fetchCalled = true
        return { status: 200, body: {} }
      }
    })
  )
  assert.equal(fetchCalled, false, 'cancel with no management secret must skip the network')
  console.log('✓ cancelProviderLogin no-ops without a management secret')
}

console.log('\nAll OAuth-flow assertions passed.')
