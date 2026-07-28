import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const mainSource = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')

assert.match(
  mainSource,
  /import \{ registerAutomationsIpc \} from '\.\/ipc\/automations'/,
  'main must import the production automation management IPC registrar'
)

const bootIndex = mainSource.indexOf('bootControlPlane()')
const runtimeIndex = mainSource.indexOf('const automations = createAutomationRuntime({')
const broadcasterIndex = mainSource.indexOf(
  'const broadcastAutomationChanged = (event: AutomationChangedEvent): void => {'
)
const adapterIndex = mainSource.indexOf(
  'const automationManagement = new AutomationManagementService({'
)
const configureIndex = mainSource.indexOf('configurePhase2ControlPlane({')
const registrationIndex = mainSource.indexOf(
  'registerAutomationsIpc(automations.service, listRegisteredControl'
)
const schedulerIndex = mainSource.indexOf('automationScheduler = automations.scheduler')

assert.ok(bootIndex >= 0, 'control registry boot was not found')
assert.ok(runtimeIndex >= 0, 'automation runtime creation was not found')
assert.ok(
  broadcasterIndex > runtimeIndex,
  'the shared change broadcaster must be created after its automation service'
)
assert.ok(
  adapterIndex > broadcasterIndex,
  'the MCP management adapter must receive the shared broadcaster before boot'
)
assert.ok(
  configureIndex > adapterIndex,
  'the automation adapter must be injected before control-plane configuration'
)
assert.ok(
  bootIndex > configureIndex,
  'the canonical registry must boot after automation management is configured'
)
assert.ok(
  registrationIndex > bootIndex,
  'renderer automation IPC must register after the canonical registry boots'
)
assert.ok(
  schedulerIndex > registrationIndex,
  'automation management IPC registration must stay adjacent to runtime creation'
)

const broadcasterBlock = mainSource.slice(broadcasterIndex, adapterIndex)
const adapterBlock = mainSource.slice(adapterIndex, configureIndex)
const wiringBlock = mainSource.slice(registrationIndex, schedulerIndex)
const configurationBlock = mainSource.slice(configureIndex, bootIndex)
assert.match(
  configurationBlock,
  /automationManagement/,
  'control-plane boot must receive the MCP automation management adapter'
)
assert.match(
  broadcasterBlock,
  /const win = getMainWindow\(\)/,
  'automation changes must resolve the current main window'
)
assert.match(
  broadcasterBlock,
  /win == null \|\| win\.isDestroyed\(\) \|\| win\.webContents\.isDestroyed\(\)/,
  'automation changes must not send to a missing or destroyed window'
)
assert.match(
  broadcasterBlock,
  /win\.webContents\.send\(PUSH_CHANNELS\.automationsChanged, event\)/,
  'automation management mutations must invalidate renderer state through the typed push channel'
)
assert.match(
  broadcasterBlock,
  /try \{[\s\S]*win\.webContents\.send\(PUSH_CHANNELS\.automationsChanged, event\)[\s\S]*\} catch \{/,
  'renderer invalidation delivery must be best-effort after a committed mutation'
)
assert.match(
  adapterBlock,
  /broadcastChanged: broadcastAutomationChanged/,
  'MCP management mutations must use the shared renderer invalidation broadcaster'
)
assert.match(
  wiringBlock,
  /registerAutomationsIpc\(\s*automations\.service,\s*listRegisteredControl,\s*broadcastAutomationChanged\s*\)/,
  'renderer IPC mutations must use the same broadcaster without wrapping or double-emitting'
)

assert.equal(
  mainSource.match(/PUSH_CHANNELS\.automationsChanged/g)?.length,
  1,
  'this slice must not add scheduler transition pushes'
)

console.log('Automation management main wiring verifier passed.')
