import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  INITIAL_APPKIT_OCCLUSION_VISIBILITY,
  INITIAL_BROWSER_WINDOW_VISIBILITY,
  INITIAL_VISIBILITY_SNAPSHOT_GENERATION,
  applyAppKitOcclusionVisibility,
  applyBrowserWindowVisibilityPush,
  applyInitialBrowserWindowVisibility,
  shouldAnimatePage
} from '../src/renderer/src/lib/usePageVisibility'

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
const preload = await readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
const main = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const miscIpc = await readFile(new URL('../src/main/ipc/misc.ts', import.meta.url), 'utf8')
const sharedIpc = await readFile(new URL('../src/shared/ipc.ts', import.meta.url), 'utf8')

assert.equal(shouldAnimatePage(true, true, true), true)
assert.equal(shouldAnimatePage(false, true, true), false)
assert.equal(shouldAnimatePage(true, false, true), false)
assert.equal(shouldAnimatePage(true, true, false), false)
assert.equal(
  INITIAL_BROWSER_WINDOW_VISIBILITY.visible,
  false,
  'mounts must fail closed before the BrowserWindow snapshot'
)
assert.equal(
  applyInitialBrowserWindowVisibility(
    INITIAL_BROWSER_WINDOW_VISIBILITY,
    false,
    INITIAL_VISIBILITY_SNAPSHOT_GENERATION
  ).visible,
  false,
  'mounting while hidden must remain non-animated after the initial snapshot'
)

const browserVisible = applyInitialBrowserWindowVisibility(
  INITIAL_BROWSER_WINDOW_VISIBILITY,
  true,
  INITIAL_VISIBILITY_SNAPSHOT_GENERATION
)
const appKitOccluded = applyAppKitOcclusionVisibility(INITIAL_APPKIT_OCCLUSION_VISIBILITY, false)
const browserRestored = applyBrowserWindowVisibilityPush(browserVisible, true)
assert.equal(
  shouldAnimatePage(true, browserRestored.visible, appKitOccluded.visible),
  false,
  'a BrowserWindow restore must not override an independently occluded AppKit window'
)

let repeatedOcclusion = appKitOccluded
for (let index = 0; index < 20; index += 1) {
  repeatedOcclusion = applyAppKitOcclusionVisibility(repeatedOcclusion, false)
}
assert.strictEqual(
  repeatedOcclusion,
  appKitOccluded,
  'duplicate per-pane native occlusion pushes must reuse state and skip rerenders'
)

const matchingHiddenPush = applyBrowserWindowVisibilityPush(
  INITIAL_BROWSER_WINDOW_VISIBILITY,
  false
)
assert.notStrictEqual(
  matchingHiddenPush,
  INITIAL_BROWSER_WINDOW_VISIBILITY,
  'the first in-flight BrowserWindow push must settle the pending snapshot even when equal'
)
assert.strictEqual(
  applyInitialBrowserWindowVisibility(
    matchingHiddenPush,
    true,
    INITIAL_VISIBILITY_SNAPSHOT_GENERATION
  ),
  matchingHiddenPush,
  'a stale visible snapshot must not override an already-received hidden push'
)

const matchingVisibleSnapshot = applyInitialBrowserWindowVisibility(
  INITIAL_BROWSER_WINDOW_VISIBILITY,
  true,
  INITIAL_VISIBILITY_SNAPSHOT_GENERATION
)
assert.strictEqual(
  applyBrowserWindowVisibilityPush(matchingVisibleSnapshot, true),
  matchingVisibleSnapshot,
  'duplicate settled BrowserWindow pushes must reuse state and skip rerenders'
)
const visiblePush = applyBrowserWindowVisibilityPush(INITIAL_BROWSER_WINDOW_VISIBILITY, true)
assert.strictEqual(
  applyInitialBrowserWindowVisibility(visiblePush, false, INITIAL_VISIBILITY_SNAPSHOT_GENERATION),
  visiblePush,
  'a stale hidden snapshot must not override an already-received visible push'
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
  /window\.api\.window\.onVisibilityChanged/,
  'the page visibility hook must subscribe to BrowserWindow lifecycle visibility'
)
assert.match(
  pageVisibility,
  /window\.api\.terminal\.onSleepStateChanged/,
  'the page visibility hook must also subscribe to authoritative native window occlusion'
)
assert.match(
  pageVisibility,
  /return \(\) => \{\s*active = false\s*unsubscribeWindow\(\)\s*unsubscribeOcclusion\(\)/,
  'the page visibility hook must remove both visibility subscriptions during cleanup'
)
assert.match(
  pageVisibility,
  /applyAppKitOcclusionVisibility\(state, !sleeping\)/,
  'native terminal sleep must disable presentation-only animation without changing liveness'
)
assert.match(pageVisibility, /useState\(\s*INITIAL_BROWSER_WINDOW_VISIBILITY\s*\)/)
assert.match(pageVisibility, /useState\(\s*INITIAL_APPKIT_OCCLUSION_VISIBILITY\s*\)/)
assert.match(
  pageVisibility,
  /shouldAnimatePage\(\s*documentVisible,\s*browserWindowVisibility\.visible,\s*appKitOcclusionVisibility\.visible\s*\)/,
  'document, BrowserWindow, and AppKit visibility must remain independent predicates'
)
assert.match(pageVisibility, /window\.api\.window\s*\.isVisible\(\)/)
assert.ok(
  pageVisibility.indexOf('window.api.window.onVisibilityChanged') <
    pageVisibility.indexOf('.isVisible()'),
  'the hook must subscribe before requesting its initial visibility snapshot'
)
assert.doesNotMatch(
  pageVisibility,
  /document\.hasFocus\(\)|window\.addEventListener\('(focus|blur)'/,
  'DOM focus must not stand in for BrowserWindow focus when Ghostty owns first responder'
)
assert.match(preload, /isVisible: \(\): Promise<boolean> => invoke\('window:isVisible'\)/)
assert.match(preload, /subscribe\(PUSH_CHANNELS\.windowVisibilityChanged, cb\)/)
assert.match(
  miscIpc,
  /win != null && !win\.isDestroyed\(\) && win\.isVisible\(\) && !win\.isMinimized\(\)/
)
assert.match(main, /mainWindow\.on\('show', pushWindowVisibility\)/)
assert.match(main, /mainWindow\.on\('hide', pushWindowVisibility\)/)
assert.match(main, /mainWindow\.on\('minimize', pushWindowVisibility\)/)
assert.match(main, /mainWindow\.on\('restore', pushWindowVisibility\)/)
assert.match(sharedIpc, /'window:isVisible': \{ req: \[\]; res: boolean \}/)
assert.match(sharedIpc, /'window:visibilityChanged': \{ visible: boolean \}/)

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
