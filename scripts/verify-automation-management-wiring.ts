import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const mainSource = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const lifecycleSource = readFileSync(
  new URL('../src/main/controlPlane/mainLifecycle.ts', import.meta.url),
  'utf8'
)

assert.match(
  lifecycleSource,
  /import \{ registerAutomationsIpc \} from '\.\.\/ipc\/automations'/,
  'the main control-plane lifecycle must import the production automation management IPC registrar'
)

const bootIndex = lifecycleSource.indexOf('bootControlPlane()')
const runtimeIndex = lifecycleSource.indexOf('const automations = createAutomationRuntime({')
const adapterIndex = lifecycleSource.indexOf(
  'const automationManagement = new AutomationManagementService({'
)
const configureIndex = lifecycleSource.indexOf('configurePhase2ControlPlane({')
const registrationIndex = lifecycleSource.indexOf('registerAutomationsIpc(', bootIndex)
const schedulerIndex = lifecycleSource.indexOf('void automations.scheduler.start()')

assert.ok(bootIndex >= 0, 'control registry boot was not found')
assert.ok(runtimeIndex >= 0, 'automation runtime creation was not found')
assert.ok(
  adapterIndex > runtimeIndex,
  'the MCP management adapter must receive the automation service before boot'
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
  'automation management IPC registration must precede scheduler startup'
)

const adapterBlock = lifecycleSource.slice(adapterIndex, configureIndex)
const wiringBlock = lifecycleSource.slice(registrationIndex, schedulerIndex)
const configurationBlock = lifecycleSource.slice(configureIndex, bootIndex)
assert.match(
  configurationBlock,
  /automationManagement/,
  'control-plane boot must receive the MCP automation management adapter'
)
assert.match(
  adapterBlock,
  /broadcastChanged: deps\.broadcastAutomationChanged/,
  'MCP management mutations must use the shared renderer invalidation broadcaster'
)
assert.match(
  wiringBlock,
  /registerAutomationsIpc\(\s*automations\.service,\s*listRegisteredControl,\s*deps\.broadcastAutomationChanged\s*\)/,
  'renderer IPC mutations must use the same broadcaster without wrapping or double-emitting'
)

assert.match(
  mainSource,
  /startMainControlPlaneLifecycle\(\{/,
  'main must start the extracted control-plane lifecycle'
)
assert.match(
  lifecycleSource,
  /disposeEvents\(\)[\s\S]*automations\.scheduler\.stop\(\)/,
  'lifecycle disposal must pair event unsubscription with scheduler shutdown'
)

console.log('Automation management main wiring verifier passed.')
