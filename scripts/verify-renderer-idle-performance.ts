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
const pageVisibility = await readFile(
  new URL('../src/renderer/src/lib/usePageVisibility.ts', import.meta.url),
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
  /const shouldAnimateRunningStatus = animateRunningStatus && pageVisible/,
  'running status animation must also require the renderer page to be visible'
)
assert.match(
  panelsSection,
  /const pageVisible = usePageVisibility\(\)/,
  'the Panes sidebar must subscribe to foreground page visibility'
)
assert.match(
  panelsSection,
  /animateRunningStatus=\{shouldAnimateRunningStatus\}/,
  'the route-and-page visibility policy must reach each layout row'
)
assert.match(
  pageVisibility,
  /document\.addEventListener\('visibilitychange', onVisibilityChange\)/,
  'the page visibility hook must subscribe to Chromium visibility changes'
)
assert.match(
  pageVisibility,
  /document\.removeEventListener\('visibilitychange', onVisibilityChange\)/,
  'the page visibility hook must remove its visibility listener during cleanup'
)
assert.match(
  pageVisibility,
  /window\.addEventListener\('focus', onVisibilityChange\)[\s\S]*window\.addEventListener\('blur', onVisibilityChange\)/,
  'the page visibility hook must react when the Electron window enters or leaves the foreground'
)
assert.match(
  pageVisibility,
  /window\.removeEventListener\('focus', onVisibilityChange\)[\s\S]*window\.removeEventListener\('blur', onVisibilityChange\)/,
  'the page visibility hook must remove both window listeners during cleanup'
)
assert.match(
  pageVisibility,
  /document\.visibilityState === 'visible' && document\.hasFocus\(\)/,
  'the page visibility hook must require both page visibility and a foreground window'
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
