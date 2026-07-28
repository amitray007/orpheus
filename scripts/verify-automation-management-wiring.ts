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
const registrationIndex = mainSource.indexOf(
  'registerAutomationsIpc(automations.service, listRegisteredControl'
)
const schedulerIndex = mainSource.indexOf('automationScheduler = automations.scheduler')

assert.ok(bootIndex >= 0, 'control registry boot was not found')
assert.ok(runtimeIndex > bootIndex, 'automation runtime must be created after the registry boots')
assert.ok(
  registrationIndex > runtimeIndex,
  'automation management IPC must register after its service is created'
)
assert.ok(
  schedulerIndex > registrationIndex,
  'automation management IPC registration must stay adjacent to runtime creation'
)

const wiringBlock = mainSource.slice(registrationIndex, schedulerIndex)
assert.match(
  wiringBlock,
  /const win = getMainWindow\(\)/,
  'automation changes must resolve the current main window'
)
assert.match(
  wiringBlock,
  /win == null \|\| win\.isDestroyed\(\) \|\| win\.webContents\.isDestroyed\(\)/,
  'automation changes must not send to a missing or destroyed window'
)
assert.match(
  wiringBlock,
  /win\.webContents\.send\(PUSH_CHANNELS\.automationsChanged, event\)/,
  'automation management mutations must invalidate renderer state through the typed push channel'
)

assert.equal(
  mainSource.match(/PUSH_CHANNELS\.automationsChanged/g)?.length,
  1,
  'this slice must not add scheduler transition pushes'
)

console.log('Automation management main wiring verifier passed.')
