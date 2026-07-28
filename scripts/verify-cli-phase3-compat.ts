import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  AppNotRunningError,
  CommandTransportError,
  SubscriptionError
} from '../packages/orpheus-cli/src/socket-client.ts'
import {
  invalidateConnectionCache,
  sendCommand,
  subscribe
} from '../packages/orpheus-cli/src/socket-client.ts'
import { runWithSingleAppRetry } from '../packages/orpheus-cli/src/live-retry.ts'
import { archiveEach } from '../packages/orpheus-cli/src/commands/ws-lifecycle.ts'
import {
  didRequestedTaskStagingFail,
  resolveTaskIntent
} from '../packages/orpheus-cli/src/commands/ws-new.ts'
import { parseDurationMs } from '../packages/orpheus-cli/src/commands/ws-wait.ts'

type CloseableServer = http.Server | net.Server

async function listen(server: CloseableServer, socketPath: string): Promise<void> {
  fs.rmSync(socketPath, { force: true })
  server.listen(socketPath)
  await once(server, 'listening')
}

async function close(server: CloseableServer): Promise<void> {
  server.close()
  await once(server, 'close')
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function runCli(
  repoRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [process.execPath, path.join(repoRoot, 'packages/orpheus-cli/dist/cli.cjs'), ...args],
    {
      cwd: repoRoot,
      env,
      stdout: 'pipe',
      stderr: 'pipe'
    }
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  return { exitCode, stdout, stderr }
}

function assertLiveHandlersRethrow(repoRoot: string): void {
  const expectedRethrows = new Map([
    ['packages/orpheus-cli/src/commands/ws-new.ts', 1],
    ['packages/orpheus-cli/src/commands/ws-send.ts', 1],
    ['packages/orpheus-cli/src/commands/ws-lifecycle.ts', 4],
    ['packages/orpheus-cli/src/commands/reviews.ts', 2]
  ])

  for (const [relativePath, expected] of expectedRethrows) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
    const actual = source.match(/if \(err instanceof AppNotRunningError\) throw err/g)?.length ?? 0
    assert.equal(
      actual,
      expected,
      `${relativePath} must rethrow every live AppNotRunningError to the top-level retry`
    )
  }

  const lifecycleSource = fs.readFileSync(
    path.join(repoRoot, 'packages/orpheus-cli/src/commands/ws-lifecycle.ts'),
    'utf8'
  )
  assert.match(
    lifecycleSource,
    /err instanceof AppNotRunningError && completedCount === 0/,
    'batch archive may only rethrow a connection failure before any id completed'
  )
}

const repoRoot = path.resolve(import.meta.dir, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpheus-cli-phase3-'))
const tokenPath = path.join(tempDir, 'cmd.token')
const commandSocket = path.join(tempDir, 'command.sock')
const resetSocket = path.join(tempDir, 'reset.sock')
const authSocket = path.join(tempDir, 'auth.sock')
const transportSocket = path.join(tempDir, 'transport.sock')
const hungHeaderSocket = path.join(tempDir, 'hung-header.sock')
const waitSocket = path.join(tempDir, 'wait.sock')
const originalEnv = {
  token: process.env.ORPHEUS_CMD_TOKEN,
  tokenFile: process.env.ORPHEUS_CMD_TOKEN_FILE,
  socket: process.env.ORPHEUS_CMD_SOCK
}

const commandBodies: string[] = []
const commandTokens: string[] = []
const commandServer = http.createServer(async (req, res) => {
  commandBodies.push(await readBody(req))
  const token =
    typeof req.headers['x-orpheus-token'] === 'string' ? req.headers['x-orpheus-token'] : ''
  commandTokens.push(token)
  if (token.startsWith('stale')) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, data: { accepted: true } }))
})

try {
  process.env.ORPHEUS_CMD_TOKEN_FILE = tokenPath
  process.env.ORPHEUS_CMD_SOCK = commandSocket
  delete process.env.ORPHEUS_CMD_TOKEN
  await listen(commandServer, commandSocket)

  // One retry means one retry: a second AppNotRunningError escapes.
  let attempts = 0
  let preparations = 0
  await assert.rejects(
    runWithSingleAppRetry(
      async () => {
        attempts++
        throw new AppNotRunningError('still unavailable')
      },
      async () => {
        preparations++
      },
      true
    ),
    AppNotRunningError
  )
  assert.equal(attempts, 2)
  assert.equal(preparations, 1)

  // A cached null token is cleared before launch; the retry resolves the token
  // file written by the newly available app and preserves the /cmd payload.
  fs.rmSync(tokenPath, { force: true })
  invalidateConnectionCache()
  attempts = 0
  preparations = 0
  const missingTokenResult = await runWithSingleAppRetry(
    async () => {
      attempts++
      return sendCommand('workspace.test', { value: 1 }, { workspaceId: 'workspace-1' })
    },
    async () => {
      preparations++
      invalidateConnectionCache()
      fs.writeFileSync(tokenPath, 'fresh-after-missing\n', { mode: 0o600 })
    },
    true
  )
  assert.deepEqual(missingTokenResult, { accepted: true })
  assert.equal(attempts, 2)
  assert.equal(preparations, 1)
  assert.deepEqual(JSON.parse(commandBodies.at(-1)!), {
    action: 'workspace.test',
    args: { value: 1 },
    context: { workspaceId: 'workspace-1' }
  })

  // A stale token rejected with 401 enters the same one-retry path and rereads
  // fresh material without including either token in any error.
  fs.writeFileSync(tokenPath, 'stale-token\n', { mode: 0o600 })
  invalidateConnectionCache()
  attempts = 0
  preparations = 0
  const staleTokenResult = await runWithSingleAppRetry(
    async () => {
      attempts++
      return sendCommand('workspace.test', { value: 2 })
    },
    async () => {
      preparations++
      invalidateConnectionCache()
      fs.writeFileSync(tokenPath, 'fresh-after-401\n', { mode: 0o600 })
    },
    true
  )
  assert.deepEqual(staleTokenResult, { accepted: true })
  assert.equal(attempts, 2)
  assert.equal(preparations, 1)
  assert.deepEqual(commandTokens.slice(-2), ['stale-token', 'fresh-after-401'])

  // Once the server has accepted the complete command body, a reset is
  // ambiguous: the mutation may already have applied, so it must not retry.
  let committedRequests = 0
  const resetServer = http.createServer(async (req) => {
    await readBody(req)
    committedRequests++
    req.socket.destroy()
  })
  await listen(resetServer, resetSocket)
  process.env.ORPHEUS_CMD_SOCK = resetSocket
  fs.writeFileSync(tokenPath, 'reset-token\n', { mode: 0o600 })
  invalidateConnectionCache()
  attempts = 0
  preparations = 0
  await assert.rejects(
    runWithSingleAppRetry(
      async () => {
        attempts++
        return sendCommand('workspace.committed-reset', { mutate: true })
      },
      async () => {
        preparations++
      },
      true
    ),
    CommandTransportError
  )
  assert.equal(committedRequests, 1)
  assert.equal(attempts, 1)
  assert.equal(preparations, 0)
  await close(resetServer)
  process.env.ORPHEUS_CMD_SOCK = commandSocket
  invalidateConnectionCache()

  // Batch archive must abort on connection failure so the central retry can
  // replay the whole batch once. It must not record the connection failure as
  // an ordinary per-id archive outcome.
  let archiveCalls = 0
  preparations = 0
  const archiveResults = await runWithSingleAppRetry(
    () =>
      archiveEach(['workspace-a', 'workspace-b'], false, async () => {
        archiveCalls++
        if (archiveCalls === 1) throw new AppNotRunningError('socket unavailable')
        return { archived: true }
      }),
    async () => {
      preparations++
    },
    true
  )
  assert.equal(archiveCalls, 3)
  assert.equal(preparations, 1)
  assert.deepEqual(
    archiveResults.map(({ id, ok }) => ({ id, ok })),
    [
      { id: 'workspace-a', ok: true },
      { id: 'workspace-b', ok: true }
    ]
  )

  // If a later batch item loses the app, completed ids are not replayed.
  // The current and pending ids remain explicit failures in the same batch
  // envelope, so the report is truthful and safe to act on.
  const partialArchiveCalls: string[] = []
  preparations = 0
  const partialArchiveResults = await runWithSingleAppRetry(
    () =>
      archiveEach(['workspace-a', 'workspace-b', 'workspace-c'], false, async (_action, args) => {
        const id = String((args as { id: unknown }).id)
        partialArchiveCalls.push(id)
        if (id === 'workspace-b') throw new AppNotRunningError('socket unavailable')
        return { archived: true }
      }),
    async () => {
      preparations++
    },
    true
  )
  assert.deepEqual(partialArchiveCalls, ['workspace-a', 'workspace-b'])
  assert.equal(preparations, 0)
  assert.equal(partialArchiveResults[0]?.ok, true)
  assert.equal(partialArchiveResults[1]?.ok, false)
  assert.match(partialArchiveResults[1]?.error ?? '', /socket unavailable/)
  assert.deepEqual(partialArchiveResults[2], {
    id: 'workspace-c',
    ok: false,
    error: 'not attempted: command connection failed after an earlier archive result'
  })
  assertLiveHandlersRethrow(repoRoot)

  // Forking alone is a complete creation intent. Task and empty remain
  // mutually exclusive, while fork + task remains valid.
  assert.deepEqual(resolveTaskIntent({ fork: true }), { ok: true })
  assert.deepEqual(resolveTaskIntent({ fork: true, task: 'review this' }), { ok: true })
  assert.equal(resolveTaskIntent({ task: 'review this', empty: true }).ok, false)
  assert.equal(resolveTaskIntent({}).ok, false)
  assert.equal(
    didRequestedTaskStagingFail(
      { task: 'stage this', 'no-submit': true },
      { seedWarning: 'Workspace runtime was not ready in time.' }
    ),
    true
  )
  assert.equal(
    didRequestedTaskStagingFail(
      { task: 'submit this' },
      { seedWarning: 'Workspace runtime was not ready in time.' }
    ),
    false
  )
  assert.equal(
    didRequestedTaskStagingFail({ empty: true, 'no-submit': true }, { seedWarning: null }),
    false
  )
  assert.equal(parseDurationMs('2h'), 7_200_000)

  // /subscribe auth failures are typed and reject; they do not resolve as if
  // the server had completed a workspace wait.
  const authServer = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
  })
  await listen(authServer, authSocket)
  process.env.ORPHEUS_CMD_SOCK = authSocket
  fs.writeFileSync(tokenPath, 'wait-token\n', { mode: 0o600 })
  invalidateConnectionCache()
  const authSubscription = subscribe({ workspaceIds: ['workspace-a'], timeoutMs: 2_000 }, () => {})
  await assert.rejects(authSubscription.done, (error: unknown) => {
    assert(error instanceof SubscriptionError)
    assert.equal(error.kind, 'auth')
    assert.equal(error.statusCode, 401)
    assert.equal(error.message.includes('wait-token'), false)
    return true
  })

  const baseCliEnv = {
    ...process.env,
    ORPHEUS_CMD_TOKEN_FILE: tokenPath,
    ORPHEUS_CMD_SOCK: authSocket
  }
  delete baseCliEnv.ORPHEUS_CMD_TOKEN
  const authCli = await runCli(
    repoRoot,
    ['--json', 'ws', 'wait', 'workspace-a', '--timeout', '2s'],
    baseCliEnv
  )
  assert.equal(authCli.exitCode, 1)
  const authOutput = JSON.parse(authCli.stdout) as Record<string, unknown>
  assert.equal(authOutput.code, 1)
  assert.match(String(authOutput.error), /subscription authentication was rejected/i)
  assert.equal('aggregate' in authOutput, false)
  await close(authServer)

  // A connection reset is a typed transport failure in both the primitive and
  // the actual CLI. ws wait exits 1 instead of fabricating reason=died/exit 13.
  const transportServer = net.createServer((socket) => {
    socket.destroy()
  })
  await listen(transportServer, transportSocket)
  process.env.ORPHEUS_CMD_SOCK = transportSocket
  invalidateConnectionCache()
  const transportSubscription = subscribe(
    { workspaceIds: ['workspace-a'], timeoutMs: 2_000 },
    () => {}
  )
  await assert.rejects(transportSubscription.done, (error: unknown) => {
    assert(error instanceof SubscriptionError)
    assert.equal(error.kind, 'transport')
    return true
  })

  const transportCli = await runCli(
    repoRoot,
    ['--json', 'ws', 'wait', 'workspace-a', '--timeout', '2s'],
    {
      ...baseCliEnv,
      ORPHEUS_CMD_SOCK: transportSocket
    }
  )
  assert.equal(transportCli.exitCode, 1)
  const transportOutput = JSON.parse(transportCli.stdout) as Record<string, unknown>
  assert.equal(transportOutput.code, 1)
  assert.match(String(transportOutput.error), /subscription/i)
  assert.equal('aggregate' in transportOutput, false)
  await close(transportServer)

  // The subscribe deadline starts before connection/header establishment. A
  // peer that accepts the socket and never sends HTTP headers resolves as an
  // ordinary wait timeout instead of hanging indefinitely.
  const hungSockets = new Set<net.Socket>()
  const hungHeaderServer = net.createServer((socket) => {
    hungSockets.add(socket)
    socket.once('close', () => hungSockets.delete(socket))
  })
  await listen(hungHeaderServer, hungHeaderSocket)
  process.env.ORPHEUS_CMD_SOCK = hungHeaderSocket
  invalidateConnectionCache()
  const hungSubscription = subscribe({ workspaceIds: ['workspace-a'], timeoutMs: 75 }, () => {}, {
    timeoutMs: 75
  })
  await hungSubscription.done
  assert.equal(hungSubscription.timedOut(), true)

  const hungCli = await runCli(
    repoRoot,
    ['--json', 'ws', 'wait', 'workspace-a', '--timeout', '100ms'],
    {
      ...baseCliEnv,
      ORPHEUS_CMD_SOCK: hungHeaderSocket
    }
  )
  assert.equal(hungCli.exitCode, 12)
  assert.deepEqual(JSON.parse(hungCli.stdout), {
    results: [{ id: 'workspace-a', reason: 'timeout' }],
    aggregate: 'timeout'
  })
  for (const socket of hungSockets) socket.destroy()
  await close(hungHeaderServer)

  // Successful streamed outcomes keep the existing long CLI duration and
  // reason/exit taxonomy unchanged.
  let waitPayload: Record<string, unknown> | null = null
  const waitServer = http.createServer(async (req, res) => {
    waitPayload = JSON.parse(await readBody(req)) as Record<string, unknown>
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write(`${JSON.stringify({ id: 'workspace-a', reason: 'blocked-input' })}\n`)
    res.write(`${JSON.stringify({ id: 'workspace-b', reason: 'timeout' })}\n`)
    res.end()
  })
  await listen(waitServer, waitSocket)
  const waitCli = await runCli(
    repoRoot,
    ['--json', 'ws', 'wait', 'workspace-a', 'workspace-b', '--timeout', '2h'],
    {
      ...baseCliEnv,
      ORPHEUS_CMD_SOCK: waitSocket
    }
  )
  assert.equal(waitCli.exitCode, 12)
  assert.deepEqual(waitPayload, {
    workspaceIds: ['workspace-a', 'workspace-b'],
    timeoutMs: 7_200_000,
    until: 'done'
  })
  assert.deepEqual(JSON.parse(waitCli.stdout), {
    results: [
      { id: 'workspace-a', reason: 'blocked-input' },
      { id: 'workspace-b', reason: 'timeout' }
    ],
    aggregate: 'timeout'
  })
  await close(waitServer)

  console.log('CLI Phase 3 compatibility verification passed')
} finally {
  invalidateConnectionCache()
  process.env.ORPHEUS_CMD_TOKEN = originalEnv.token
  process.env.ORPHEUS_CMD_TOKEN_FILE = originalEnv.tokenFile
  process.env.ORPHEUS_CMD_SOCK = originalEnv.socket
  if (commandServer.listening) await close(commandServer)
  fs.rmSync(tempDir, { recursive: true, force: true })
}
