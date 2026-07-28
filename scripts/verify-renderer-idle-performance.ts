import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const dashboard = await readFile(
  new URL('../src/renderer/src/components/dashboard/Dashboard.tsx', import.meta.url),
  'utf8'
)
const panelsSection = await readFile(
  new URL('../src/renderer/src/components/dashboard/PanelsSection.tsx', import.meta.url),
  'utf8'
)
const paneCell = await readFile(
  new URL('../src/renderer/src/components/panes/PaneCell.tsx', import.meta.url),
  'utf8'
)

assert.match(
  dashboard,
  /animateRunningStatus=\{view\.kind === 'panes'\}/,
  'the retained Panes sidebar must animate running status only on the Panes destination'
)
assert.match(
  panelsSection,
  /<ActivityIndicator detail="working" animated=\{animated\} \/>/,
  'layout liveness must remain visible while allowing its ticker to be disabled'
)
assert.match(
  panelsSection,
  /animateRunningStatus=\{animateRunningStatus\}/,
  'the off-view animation policy must reach each layout row'
)

const teardownMarker = paneCell.match(
  /\/\/ True teardown marker[\s\S]*?useEffect\(\(\) => \{([\s\S]*?)\n[ ]{2}\}, \[\]\)/
)
assert.ok(teardownMarker, 'PaneCell must retain an unmount marker for in-flight mounts')
assert.doesNotMatch(
  teardownMarker[1],
  /\.hide\(/,
  'the teardown marker must not duplicate the lifecycle effect pane:hide IPC'
)
assert.match(
  teardownMarker[1],
  /unmountedRef\.current = true/,
  'the teardown marker must still protect an in-flight mount from leaking'
)

console.log('renderer idle performance verification passed')
