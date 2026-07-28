import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import * as http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { getCmdSockPath, resolveAppName } from '../packages/orpheus-cli/src/paths.ts'
import {
  buildManagedMcpFlagsString,
  buildManagedMcpFlagTokens
} from '../src/main/controlPlane/managedMcpLaunch.ts'
import { FLAG_DELIMITER } from '../src/shared/cliFlags.ts'
import { ControlToolExposureStore } from '../src/main/controlPlane/controlToolExposure.ts'
import type { ControlDescription } from '../src/main/controlPlane/types.ts'

type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: number
  method?: string
  result?: Record<string, unknown>
  error?: Record<string, unknown>
}

const repoRoot = path.resolve(import.meta.dirname, '..')
const bundlePath = path.join(repoRoot, 'packages/orpheus-mcp/dist/mcp.cjs')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orpheus-mcp-'))
const socketPath = path.join(tempDir, 'control.sock')
const leaseToken = 'offline-runtime-lease'
const requests: Array<Record<string, unknown>> = []
let catalogRevision = 1
let publishedCapabilities: Array<Record<string, unknown>> = []
let deniedInvokeCount = 0
let sideEffectCount = 0
const catalogWaitResponses = new Set<http.ServerResponse>()

const capability = {
  id: 'dynamic.echo',
  version: 1,
  kind: 'query',
  description: 'Echo a value from the fake control plane.',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: { echoed: { type: 'string' } },
    required: ['echoed'],
    additionalProperties: false
  },
  allowedSurfaces: ['mcp'],
  permission: 'test.read',
  scope: { kind: 'workspace', inputField: 'workspaceId' },
  risk: { tier: 0, label: 'read-only' }
}

const arrayCapability = {
  ...capability,
  id: 'reviews.list',
  description: 'List review comments.',
  inputSchema: {
    type: 'object',
    properties: { workspaceId: { type: 'string' } },
    required: ['workspaceId'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'array',
    items: {
      type: 'object',
      properties: { id: { type: 'string' }, body: { type: 'string' } },
      required: ['id', 'body'],
      additionalProperties: false
    }
  }
}
publishedCapabilities = [capability, arrayCapability]

function samePublishedCapabilities(next: Array<Record<string, unknown>>): boolean {
  return (
    next.length === publishedCapabilities.length &&
    next.every((capabilityValue, index) => capabilityValue.id === publishedCapabilities[index]?.id)
  )
}

function publishCatalog(next: Array<Record<string, unknown>>): boolean {
  if (samePublishedCapabilities(next)) return false
  publishedCapabilities = next
  catalogRevision++
  for (const response of [...catalogWaitResponses]) {
    catalogWaitResponses.delete(response)
    if (response.destroyed) continue
    response.end(
      JSON.stringify({
        ok: true,
        data: { protocolVersion: 1, revision: catalogRevision, changed: true }
      })
    )
  }
  return true
}

function completeCatalogWaitWithoutChange(): boolean {
  const response = catalogWaitResponses.values().next().value as http.ServerResponse | undefined
  if (response == null) return false
  catalogWaitResponses.delete(response)
  if (!response.destroyed) {
    response.end(
      JSON.stringify({
        ok: true,
        data: { protocolVersion: 1, revision: catalogRevision, changed: false }
      })
    )
  }
  return true
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const fakeControlServer = http.createServer((req, res) => {
  void (async () => {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/control')
    assert.equal(req.headers['x-orpheus-runtime-lease'], leaseToken)

    const body = JSON.parse(await readBody(req)) as Record<string, unknown>
    requests.push(body)
    assert.equal(body.protocolVersion, 1)

    res.writeHead(200, { 'content-type': 'application/json' })
    if (body.op === 'catalog') {
      res.end(
        JSON.stringify({
          ok: true,
          data: {
            protocolVersion: 1,
            revision: catalogRevision,
            capabilities: publishedCapabilities
          }
        })
      )
      return
    }
    if (body.op === 'catalog.wait') {
      const afterRevision = body.afterRevision
      assert.equal(typeof afterRevision, 'number')
      if ((afterRevision as number) < catalogRevision) {
        res.end(
          JSON.stringify({
            ok: true,
            data: { protocolVersion: 1, revision: catalogRevision, changed: true }
          })
        )
        return
      }
      catalogWaitResponses.add(res)
      const removePendingWait = (): void => {
        catalogWaitResponses.delete(res)
      }
      res.once('close', removePendingWait)
      res.once('error', removePendingWait)
      req.once('aborted', removePendingWait)
      req.once('close', removePendingWait)
      req.once('error', removePendingWait)
      req.socket.once('end', removePendingWait)
      req.socket.once('error', removePendingWait)
      req.socket.once('close', removePendingWait)
      return
    }
    if (body.op === 'invoke' && body.id === capability.id) {
      if (!publishedCapabilities.some((entry) => entry.id === capability.id)) {
        deniedInvokeCount++
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: 'forbidden', message: 'disabled in Settings' }
          })
        )
        return
      }
      const input = body.input as Record<string, unknown>
      sideEffectCount++
      res.end(JSON.stringify({ ok: true, data: { echoed: input.value } }))
      return
    }
    if (body.op === 'invoke' && body.id === arrayCapability.id) {
      res.end(
        JSON.stringify({
          ok: true,
          data: [{ id: 'review-1', body: 'Keep this behavior.' }]
        })
      )
      return
    }
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: 'not_found', message: 'not published' }
      })
    )
  })().catch((error: unknown) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: 'harness_failed', message: String(error) }
      })
    )
  })
})

await new Promise<void>((resolve, reject) => {
  fakeControlServer.once('error', reject)
  fakeControlServer.listen(socketPath, resolve)
})

// Production runs this bundle under Electron-as-Node. Use Node here too:
// Bun's node:http compatibility layer does not close an in-flight Unix-socket
// response when its spawned Bun process exits, which masks disconnect cleanup.
const child = spawn(process.env.NODE_BINARY ?? 'node', [bundlePath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ORPHEUS_CMD_SOCK: socketPath,
    ORPHEUS_RUNTIME_LEASE_TOKEN: leaseToken
  }
})

const messages: JsonRpcMessage[] = []
let stdoutBuffer = ''
let stderr = ''
const waiters = new Map<number, (message: JsonRpcMessage) => void>()

child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk: string) => {
  stdoutBuffer += chunk
  let newlineIndex = stdoutBuffer.indexOf('\n')
  while (newlineIndex >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex)
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
    if (line.length > 0) {
      const message = JSON.parse(line) as JsonRpcMessage
      messages.push(message)
      if (typeof message.id === 'number') {
        waiters.get(message.id)?.(message)
        waiters.delete(message.id)
      }
    }
    newlineIndex = stdoutBuffer.indexOf('\n')
  }
})
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk: string) => {
  stderr += chunk
})

function request(
  id: number,
  method: string,
  params?: Record<string, unknown>
): Promise<JsonRpcMessage> {
  const response = new Promise<JsonRpcMessage>((resolve, reject) => {
    const timeout = setTimeout(() => {
      waiters.delete(id)
      reject(new Error(`timed out waiting for ${method}`))
    }, 5_000)
    waiters.set(id, (message) => {
      clearTimeout(timeout)
      resolve(message)
    })
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return response
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

function toolListChangedCount(): number {
  return messages.filter((message) => message.method === 'notifications/tools/list_changed').length
}

const initialize = await request(1, 'initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'offline-harness', version: '1.0.0' }
})
assert.ok(initialize.result)
assert.deepEqual((initialize.result?.capabilities as Record<string, unknown>)?.tools, {
  listChanged: true
})
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

const listed = await request(2, 'tools/list')
assert.deepEqual(
  (listed.result?.tools as Array<Record<string, unknown>>).map((tool) => tool.name),
  [capability.id, arrayCapability.id]
)
assert.deepEqual(
  (listed.result?.tools as Array<Record<string, unknown>>)[0]?.inputSchema,
  capability.inputSchema
)
assert.deepEqual((listed.result?.tools as Array<Record<string, unknown>>)[0]?.outputSchema, {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: capability.outputSchema }
})
assert.deepEqual((listed.result?.tools as Array<Record<string, unknown>>)[1]?.outputSchema, {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: { value: arrayCapability.outputSchema }
})

const called = await request(3, 'tools/call', {
  name: capability.id,
  arguments: { value: 'hello' }
})
const callContent = called.result?.content as Array<Record<string, unknown>>
assert.deepEqual(JSON.parse(callContent[0]?.text as string), { echoed: 'hello' })
assert.deepEqual(called.result?.structuredContent, { value: { echoed: 'hello' } })
assert.equal(called.result?.isError, undefined)

const arrayCalled = await request(4, 'tools/call', {
  name: arrayCapability.id,
  arguments: { workspaceId: 'workspace-1' }
})
const reviewValue = [{ id: 'review-1', body: 'Keep this behavior.' }]
assert.deepEqual(
  JSON.parse((arrayCalled.result?.content as Array<Record<string, unknown>>)[0]?.text as string),
  reviewValue
)
assert.deepEqual(arrayCalled.result?.structuredContent, { value: reviewValue })

await waitFor(() => catalogWaitResponses.size === 1, 'initial catalog wait')
const waitRequestsBeforeTimeout = requests.filter((entry) => entry.op === 'catalog.wait').length
const notificationsBeforeTimeout = toolListChangedCount()
assert.equal(completeCatalogWaitWithoutChange(), true)
await waitFor(
  () =>
    requests.filter((entry) => entry.op === 'catalog.wait').length > waitRequestsBeforeTimeout &&
    catalogWaitResponses.size === 1,
  'catalog wait repoll after timeout'
)
assert.equal(toolListChangedCount(), notificationsBeforeTimeout)

// Writing the same effective exposure is a no-op: no revision and no notification.
assert.equal(publishCatalog([capability, arrayCapability]), false)
assert.equal(catalogRevision, 1)
assert.equal(toolListChangedCount(), notificationsBeforeTimeout)

// Disable one tool and verify the persistent MCP process announces and serves
// the new list without a restart.
assert.equal(publishCatalog([arrayCapability]), true)
await waitFor(() => toolListChangedCount() === 1, 'tool removal notification')
const afterDisable = await request(5, 'tools/list')
assert.deepEqual(
  (afterDisable.result?.tools as Array<Record<string, unknown>>).map((tool) => tool.name),
  [arrayCapability.id]
)

// A client may call a name cached before the notification. The bridge sends
// it to main, whose invoke-time authorization rejects it; no handler effect runs.
const staleDisabled = await request(6, 'tools/call', {
  name: capability.id,
  arguments: { value: 'must-not-run' }
})
assert.equal(staleDisabled.result?.isError, true)
assert.match(
  (staleDisabled.result?.content as Array<Record<string, string>>)[0]?.text ?? '',
  /forbidden/
)
assert.equal(deniedInvokeCount, 1)
assert.equal(sideEffectCount, 1)

assert.equal(publishCatalog([capability, arrayCapability]), true)
await waitFor(() => toolListChangedCount() === 2, 'tool re-enable notification')
const afterEnable = await request(7, 'tools/list')
assert.deepEqual(
  (afterEnable.result?.tools as Array<Record<string, unknown>>).map((tool) => tool.name),
  [capability.id, arrayCapability.id]
)

// Category-level disable is represented by the complete effective catalog
// change and emits one notification for the burst.
assert.equal(publishCatalog([]), true)
await waitFor(() => toolListChangedCount() === 3, 'category disable notification')
const afterCategoryDisable = await request(8, 'tools/list')
assert.deepEqual(afterCategoryDisable.result?.tools, [])
assert.equal(publishCatalog([]), false)
assert.equal(toolListChangedCount(), 3)

const unknown = await request(9, 'tools/call', {
  name: 'not.published',
  arguments: {}
})
assert.equal(unknown.result?.isError, true)
assert.match((unknown.result?.content as Array<Record<string, string>>)[0]?.text ?? '', /not_found/)

assert.ok(requests.some((entry) => entry.op === 'catalog'))
assert.ok(requests.some((entry) => entry.op === 'catalog.wait'))
assert.ok(requests.some((entry) => entry.op === 'invoke' && entry.id === capability.id))
assert.ok(requests.some((entry) => entry.op === 'invoke' && entry.id === arrayCapability.id))
assert.ok(requests.some((entry) => entry.op === 'invoke' && entry.id === 'not.published'))
assert.equal(stderr, '')
assert.ok(messages.every((message) => message.jsonrpc === '2.0'))

child.stdin.end()
let requiredTerminationSignal = false
await new Promise<void>((resolve) => {
  const terminate = setTimeout(() => {
    requiredTerminationSignal = true
    child.kill('SIGTERM')
  }, 2_000)
  const force = setTimeout(() => child.kill('SIGKILL'), 4_000)
  child.once('exit', () => {
    clearTimeout(terminate)
    clearTimeout(force)
    resolve()
  })
})
assert.equal(
  requiredTerminationSignal,
  false,
  'MCP bridge must abort its catalog wait and exit when stdin disconnects'
)
fakeControlServer.closeAllConnections()
catalogWaitResponses.clear()
await new Promise<void>((resolve) => fakeControlServer.close(() => resolve()))

const priorVariant = process.env.ORPHEUS_DATA_VARIANT
const priorSocket = process.env.ORPHEUS_CMD_SOCK
process.env.ORPHEUS_DATA_VARIANT = 'wt'
delete process.env.ORPHEUS_CMD_SOCK
assert.equal(resolveAppName(), 'Orpheus WT')
process.env.ORPHEUS_CMD_SOCK = socketPath
assert.equal(getCmdSockPath(), socketPath)
process.env.ORPHEUS_CMD_SOCK = 'relative.sock'
assert.match(getCmdSockPath(), /Orpheus WT\/cmd\.sock$/)
if (priorVariant == null) delete process.env.ORPHEUS_DATA_VARIANT
else process.env.ORPHEUS_DATA_VARIANT = priorVariant
if (priorSocket == null) delete process.env.ORPHEUS_CMD_SOCK
else process.env.ORPHEUS_CMD_SOCK = priorSocket

for (const manifest of [
  'electron-builder.yml',
  'electron-builder-dev.yml',
  'electron-builder-wt.yml'
]) {
  const source = fs.readFileSync(path.join(repoRoot, manifest), 'utf8')
  assert.match(source, /resources\/bin\/orpheus-mcp/)
  assert.match(source, /packages\/orpheus-mcp\/dist\/mcp\.cjs/)
  assert.match(source, /resources\/bin\/orpheus(?:\r?\n|$)/)
  assert.match(source, /packages\/orpheus-cli\/dist\/cli\.cjs/)
}

const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
assert.match(packageJson.scripts.typecheck ?? '', /\btypecheck:mcp\b/)
assert.equal((packageJson.scripts.build?.match(/\bbuild:agents\b/g) ?? []).length, 1)
for (const scriptName of ['build:dev', 'build:wt', 'build:mac']) {
  const script = packageJson.scripts[scriptName] ?? ''
  assert.match(script, /\bbun run build\b/)
  assert.doesNotMatch(script, /\bbuild:agents\b/)
}

assert.ok((fs.statSync(path.join(repoRoot, 'resources/bin/orpheus-mcp')).mode & 0o111) !== 0)
assert.ok(fs.statSync(bundlePath).size > 0)
assert.doesNotMatch(fs.readFileSync(bundlePath, 'utf8'), /better-sqlite3/)

const resourcesPath = '/Applications/Orpheus Dev.app/Contents/Resources'
const managedTokens = buildManagedMcpFlagTokens(resourcesPath)
assert.equal(managedTokens[0], '--mcp-config')
assert.equal(managedTokens.length, 2)
assert.deepEqual(JSON.parse(managedTokens[1]), {
  mcpServers: {
    'orpheus-control': {
      type: 'stdio',
      command: `${resourcesPath}/bin/orpheus-mcp`,
      args: []
    }
  }
})
assert.equal(buildManagedMcpFlagsString(resourcesPath), managedTokens.join(FLAG_DELIMITER))
assert.doesNotMatch(buildManagedMcpFlagsString(resourcesPath), /--strict-mcp-config/)
assert.doesNotMatch(managedTokens[1], /ORPHEUS_|runtime|lease|token/i)
assert.throws(() => buildManagedMcpFlagTokens('relative/resources'), /must be absolute/)

const exposureDb = new Database(':memory:')
exposureDb.exec(`
  CREATE TABLE control_tool_category_preferences (
    category_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE control_tool_preferences (
    operation_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`)
let exposureNow = 1
const exposure = new ControlToolExposureStore(
  exposureDb,
  () => [capability, arrayCapability] as ControlDescription[],
  () => ++exposureNow
)
assert.equal(exposure.getCatalogRevision(), 1)
const changedWait = exposure.waitForCatalogRevision(1, 1_000)
exposure.update({ target: 'tool', id: capability.id, enabled: false })
assert.deepEqual(await changedWait, { revision: 2, changed: true })
assert.equal(exposure.getCatalogRevision(), 2)
exposure.update({ target: 'tool', id: capability.id, enabled: false })
assert.equal(exposure.getCatalogRevision(), 2, 'same effective tool state must not bump revision')
exposure.reset({ target: 'category', id: 'projects' })
assert.equal(exposure.getCatalogRevision(), 2, 'no-op category reset must not bump revision')
exposure.update({ target: 'category', id: 'reviews', enabled: false })
assert.equal(exposure.getCatalogRevision(), 3)
exposure.update({ target: 'tool', id: arrayCapability.id, enabled: false })
assert.equal(
  exposure.getCatalogRevision(),
  3,
  'tool override under a disabled category must not bump effective catalog revision'
)
assert.deepEqual(await exposure.waitForCatalogRevision(3, 5), {
  revision: 3,
  changed: false
})
const aborted = new AbortController()
const abortedWait = exposure.waitForCatalogRevision(3, 1_000, aborted.signal)
aborted.abort()
await assert.rejects(abortedWait, /aborted/)
await assert.rejects(exposure.waitForCatalogRevision(4, 5), /revision is invalid/)
exposureDb.close()

fs.rmSync(tempDir, { recursive: true, force: true })
console.log('verify-mcp-bridge: all assertions passed')
