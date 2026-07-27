import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
          data: { protocolVersion: 1, capabilities: [capability, arrayCapability] }
        })
      )
      return
    }
    if (body.op === 'invoke' && body.id === capability.id) {
      const input = body.input as Record<string, unknown>
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

const child = spawn(process.execPath, [bundlePath], {
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

const initialize = await request(1, 'initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'offline-harness', version: '1.0.0' }
})
assert.ok(initialize.result)
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

const unknown = await request(5, 'tools/call', {
  name: 'not.published',
  arguments: {}
})
assert.equal(unknown.result?.isError, true)
assert.match((unknown.result?.content as Array<Record<string, string>>)[0]?.text ?? '', /not_found/)

assert.ok(requests.some((entry) => entry.op === 'catalog'))
assert.ok(requests.some((entry) => entry.op === 'invoke' && entry.id === capability.id))
assert.ok(requests.some((entry) => entry.op === 'invoke' && entry.id === arrayCapability.id))
assert.ok(!requests.some((entry) => entry.op === 'invoke' && entry.id === 'not.published'))
assert.equal(stderr, '')
assert.ok(messages.every((message) => message.jsonrpc === '2.0'))

child.stdin.end()
await new Promise<void>((resolve) => {
  const timeout = setTimeout(() => {
    child.kill('SIGTERM')
    resolve()
  }, 2_000)
  child.once('exit', () => {
    clearTimeout(timeout)
    resolve()
  })
})
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

fs.rmSync(tempDir, { recursive: true, force: true })
console.log('verify-mcp-bridge: all assertions passed')
