// ---------------------------------------------------------------------------
// scripts/verify-control-plane.ts
//
// Deterministic, offline Phase 1 control-plane harness. It exercises the pure
// registry with injected review handlers and statically guards the two existing
// adapter contracts. It does not import Electron, open the DB, start the command
// socket, or launch Orpheus.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ControlRegistry, unwrapControlResult } from '../src/main/controlPlane/registry.ts'
import { bootControlRegistry } from '../src/main/controlPlane/boot.ts'
import {
  REVIEW_LIST_CONTROL_ID,
  REVIEW_SET_RESOLVED_CONTROL_ID
} from '../src/main/controlPlane/reviewCapabilities.ts'
import {
  commandReviewContext,
  invokeReviewList,
  invokeReviewSetResolved,
  rendererReviewContext,
  resolveCommandReviewListInput,
  resolveCommandReviewSetResolvedInput
} from '../src/main/reviewControlAdapter.ts'
import type {
  ControlContext,
  ControlDescriptor,
  ControlInvoker,
  ReviewCapabilityHandlers
} from '../src/main/controlPlane/types.ts'
import type { LocalReviewComment } from '../src/shared/types.ts'

const repoRoot = path.resolve(import.meta.dirname, '..')
const readRepoFile = (relativePath: string): string =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

const context: ControlContext = {
  principal: { type: 'workspace-agent', id: 'workspace-1' },
  consumer: 'command-socket',
  workspaceId: 'workspace-1',
  projectId: null,
  requestId: 'request-1'
}

const comment: LocalReviewComment = {
  id: 'comment-1',
  workspaceId: 'workspace-1',
  prNumber: 42,
  path: 'src/example.ts',
  line: 12,
  startLine: null,
  side: 'RIGHT',
  body: 'Keep this behavior.',
  author: 'you',
  resolved: false,
  createdAt: 100,
  updatedAt: 100
}

let listCalls = 0
let resolveCalls = 0
let receivedContext: ControlContext | null = null
let receivedWorkspaceId: string | null = null
let receivedCommentId: string | null = null
let receivedResolved: boolean | null = null

const handlers: ReviewCapabilityHandlers = {
  listByWorkspace: (workspaceId, invocationContext) => {
    listCalls++
    receivedContext = invocationContext
    receivedWorkspaceId = workspaceId
    return workspaceId === '' ? [] : [comment]
  },
  setResolved: (id, resolved, invocationContext) => {
    resolveCalls++
    receivedContext = invocationContext
    receivedCommentId = id
    receivedResolved = resolved
    if (id === '') throw new Error('Local review comment not found: ')
    return { ...comment, resolved, updatedAt: 200 }
  }
}

const registry = new ControlRegistry()
bootControlRegistry(registry, handlers)

// Descriptor metadata is internally discoverable but not published to actions:list.
{
  const listDescription = registry.describe(REVIEW_LIST_CONTROL_ID)
  assert.ok(listDescription)
  assert.equal(listDescription.id, REVIEW_LIST_CONTROL_ID)
  assert.equal(listDescription.version, 1)
  assert.equal(listDescription.kind, 'query')
  assert.deepEqual(listDescription.allowedSurfaces, ['renderer', 'command-socket'])
  assert.equal(listDescription.permission, 'reviews.read')
  assert.equal(listDescription.inputSchema.type, 'object')
  assert.equal(listDescription.outputSchema.type, 'array')

  const resolveDescription = registry.describe(REVIEW_SET_RESOLVED_CONTROL_ID)
  assert.ok(resolveDescription)
  assert.equal(resolveDescription.kind, 'mutation')
  assert.equal(resolveDescription.permission, 'reviews.resolve')
  assert.equal(resolveDescription.risk.tier, 2)
  assert.equal(registry.list().length, 2)
}

// Repeated boot fails clearly rather than silently overwriting a handler.
assert.throws(
  () => bootControlRegistry(registry, handlers),
  /Control capability already registered: reviews\.list/
)

// Unknown ids and invalid input are normalized without running handlers.
{
  const unknown = await registry.invoke({ id: 'missing.capability', input: {}, context })
  assert.deepEqual(unknown, {
    ok: false,
    code: 'not_found',
    error: 'Control capability not found: missing.capability'
  })

  const invalidList = await registry.invoke({
    id: REVIEW_LIST_CONTROL_ID,
    input: { workspaceId: 42 },
    context
  })
  assert.equal(invalidList.ok, false)
  assert.equal(invalidList.ok ? null : invalidList.code, 'invalid')

  const invalidResolve = await registry.invoke({
    id: REVIEW_SET_RESOLVED_CONTROL_ID,
    input: { id: false, resolved: 'yes' },
    context
  })
  assert.equal(invalidResolve.ok, false)
  assert.equal(invalidResolve.ok ? null : invalidResolve.code, 'invalid')
  assert.equal(listCalls, 0)
  assert.equal(resolveCalls, 0)
}

// Empty strings are valid at the registry boundary for renderer compatibility:
// listByWorkspace('') historically returns [], while setResolved('') reaches
// reviewStore and produces its existing not-found message.
{
  const emptyList = await registry.invoke<LocalReviewComment[]>({
    id: REVIEW_LIST_CONTROL_ID,
    input: { workspaceId: '' },
    context
  })
  assert.deepEqual(unwrapControlResult(emptyList), [])
  assert.equal(receivedWorkspaceId, '')

  const emptyResolve = await registry.invoke<LocalReviewComment>({
    id: REVIEW_SET_RESOLVED_CONTROL_ID,
    input: { id: '', resolved: true },
    context
  })
  assert.deepEqual(emptyResolve, {
    ok: false,
    code: 'failed',
    error: 'Local review comment not found: '
  })
}

// Successful values keep the exact existing domain shapes, and context/request id
// reach the proof handler unchanged.
{
  const listResult = await registry.invoke<LocalReviewComment[]>({
    id: REVIEW_LIST_CONTROL_ID,
    input: { workspaceId: 'workspace-1' },
    context
  })
  assert.deepEqual(unwrapControlResult(listResult), [comment])
  assert.strictEqual(receivedContext, context)
  assert.equal(receivedWorkspaceId, 'workspace-1')

  const resolveResult = await registry.invoke<LocalReviewComment>({
    id: REVIEW_SET_RESOLVED_CONTROL_ID,
    input: { id: 'comment-1', resolved: true },
    context
  })
  assert.deepEqual(unwrapControlResult(resolveResult), {
    ...comment,
    resolved: true,
    updatedAt: 200
  })
  assert.strictEqual(receivedContext, context)
  assert.equal(receivedCommentId, 'comment-1')
  assert.equal(receivedResolved, true)
}

// Exercise the actual pure adapter used by IPC and the command socket. It maps
// stable ids/input/context into the registry and unwraps values/errors.
{
  const invocations: Parameters<ControlInvoker>[0][] = []
  const fakeInvoke: ControlInvoker = async <T>(invocation) => {
    invocations.push(invocation)
    const value =
      invocation.id === REVIEW_LIST_CONTROL_ID ? [comment] : { ...comment, resolved: true }
    return { ok: true, value: value as T }
  }

  const rendererContext = rendererReviewContext(17, '')
  assert.deepEqual(rendererContext.principal, {
    type: 'renderer-user',
    id: 'webContents:17'
  })
  assert.equal(rendererContext.workspaceId, '')
  assert.ok(rendererContext.requestId.length > 0)

  assert.deepEqual(await invokeReviewList(fakeInvoke, { workspaceId: '' }, rendererContext), [
    comment
  ])
  assert.equal(invocations[0]?.id, REVIEW_LIST_CONTROL_ID)
  assert.deepEqual(invocations[0]?.input, { workspaceId: '' })
  assert.strictEqual(invocations[0]?.context, rendererContext)

  const commandContext = commandReviewContext('ambient-workspace')
  assert.deepEqual(commandContext.principal, { type: 'cli', id: 'command-socket' })
  assert.equal(commandContext.workspaceId, 'ambient-workspace')
  assert.deepEqual(
    await invokeReviewSetResolved(fakeInvoke, { id: 'comment-1', resolved: true }, commandContext),
    { ...comment, resolved: true }
  )
  assert.equal(invocations[1]?.id, REVIEW_SET_RESOLVED_CONTROL_ID)
  assert.strictEqual(invocations[1]?.context, commandContext)

  const failingInvoke: ControlInvoker = async () => ({
    ok: false,
    code: 'failed',
    error: 'adapter domain error'
  })
  await assert.rejects(
    () =>
      invokeReviewSetResolved(failingInvoke, { id: 'comment-1', resolved: false }, commandContext),
    /^Error: adapter domain error$/
  )
}

// Execute the actual command-socket fallback and prevalidation helpers. Ambient
// context remains first for target selection, but never changes the CLI principal.
{
  assert.deepEqual(
    resolveCommandReviewListInput(
      { workspaceId: 'argument-workspace' },
      { workspaceId: 'ambient-workspace' }
    ),
    { workspaceId: 'ambient-workspace' }
  )
  assert.deepEqual(resolveCommandReviewListInput({ workspaceId: 'argument-workspace' }, {}), {
    workspaceId: 'argument-workspace'
  })
  assert.throws(
    () => resolveCommandReviewListInput({ workspaceId: '' }, {}),
    /^Error: workspaceId is required \(no context workspace either\)$/
  )
  assert.deepEqual(
    resolveCommandReviewSetResolvedInput(
      { id: 'comment-1', resolved: false },
      'args.id is required'
    ),
    { id: 'comment-1', resolved: false }
  )
  assert.throws(
    () => resolveCommandReviewSetResolvedInput({ id: '', resolved: false }, 'args.id is required'),
    /^Error: args\.id is required$/
  )
  assert.throws(
    () =>
      resolveCommandReviewSetResolvedInput(
        { id: 'comment-1', resolved: 'false' },
        'args.id is required'
      ),
    /^Error: args\.resolved is required \(boolean\)$/
  )
}

// Handler exceptions become failed control results while adapter unwrapping
// restores the original public error message.
{
  const throwingRegistry = new ControlRegistry()
  const throwingDescriptor: ControlDescriptor<{ value: string }, string> = {
    id: 'proof.throw',
    version: 1,
    kind: 'query',
    description: 'Throw for verification.',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'string' },
    allowedSurfaces: ['command-socket'],
    permission: 'reviews.read',
    scope: { kind: 'resource', inputField: 'value' },
    risk: { tier: 0, label: 'read' },
    validateInput: (input): input is { value: string } =>
      input != null &&
      typeof input === 'object' &&
      typeof (input as Record<string, unknown>)['value'] === 'string',
    handler: () => {
      throw new Error('unchanged domain error')
    }
  }
  throwingRegistry.register(throwingDescriptor)
  const result = await throwingRegistry.invoke<string>({
    id: 'proof.throw',
    input: { value: 'x' },
    context
  })
  assert.deepEqual(result, { ok: false, code: 'failed', error: 'unchanged domain error' })
  assert.throws(() => unwrapControlResult(result), /^Error: unchanged domain error$/)
}

// Static compatibility guards: the live adapters route only the proof actions,
// while their existing external channel/action names and error/envelope strings
// remain present. Quick Actions discovery and CLI stay separate.
{
  const ipcSource = readRepoFile('src/main/ipc/reviews.ts')
  assert.match(ipcSource, /handle\('reviews:list'/)
  assert.match(ipcSource, /handle\('reviews:setResolved'/)
  assert.match(ipcSource, /invokeReviewList/)
  assert.match(ipcSource, /invokeReviewSetResolved/)

  const commandSource = readRepoFile('src/main/commandServer.ts')
  assert.match(commandSource, /'reviews\.list': async/)
  assert.match(commandSource, /'reviews\.setResolved': async/)
  assert.match(commandSource, /resolveCommandReviewListInput/)
  assert.match(commandSource, /resolveCommandReviewSetResolvedInput/)
  assert.match(commandSource, /\{ ok: true, data \}/)
  assert.match(commandSource, /\{ ok: false, error: message \}/)
  const commandDispatchStart = commandSource.indexOf('async function dispatchCmdAndRespond(')
  const commandDispatchEnd = commandSource.indexOf('// Server lifecycle', commandDispatchStart)
  const commandDispatchSource = commandSource.slice(commandDispatchStart, commandDispatchEnd)
  assert.match(commandDispatchSource, /clientSafeCommandErrorMessage\(err\)/)
  assert.doesNotMatch(commandDispatchSource, /String\(err\)|redactErrorMessage\(err\)|err\.stack/)

  const quickActionsSource = readRepoFile('src/main/actions/index.ts')
  assert.doesNotMatch(quickActionsSource, /reviews\.list|reviews\.setResolved/)
  const actionsIpcSource = readRepoFile('src/main/ipc/actions.ts')
  assert.match(actionsIpcSource, /handle\('actions:list', \(\) => actionsList\(\)\)/)

  const cliSource = readRepoFile('packages/orpheus-cli/src/commands/reviews.ts')
  assert.doesNotMatch(cliSource, /controlPlane/)
  assert.match(cliSource, /sendCommand\('reviews\.list'/)
  assert.match(cliSource, /sendCommand\('reviews\.setResolved'/)
}

// The pure registry and descriptor files remain free of transport/framework
// imports. index.ts is the intentional composition root that imports reviewStore.
{
  for (const relativePath of [
    'src/main/controlPlane/types.ts',
    'src/main/controlPlane/registry.ts',
    'src/main/controlPlane/reviewCapabilities.ts',
    'src/main/controlPlane/boot.ts',
    'src/main/reviewControlAdapter.ts'
  ]) {
    const source = readRepoFile(relativePath)
    assert.doesNotMatch(
      source,
      /from ['"].*(electron|preload|renderer|orpheus-cli|commandServer|http|mcp)/i,
      `${relativePath} must remain transport-neutral`
    )
  }
}

console.log('✓ control-plane registry and review proof slice verified')
