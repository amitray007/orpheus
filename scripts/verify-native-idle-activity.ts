import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repositoryRoot = path.resolve(import.meta.dir, '..')
const addonPath = path.join(repositoryRoot, 'packages/ghostty-surface/addon.mm')
const source = readFileSync(addonPath, 'utf8')

function between(start: string, end: string): string {
  const startIndex = source.indexOf(start)
  assert.notEqual(startIndex, -1, `missing native source marker: ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `missing native source marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

const activityHelper = between(
  'static void reconcileTerminalActivities()',
  '// Screen text is sensitive'
)
assert.match(activityHelper, /NSThread isMainThread/)
assert.match(activityHelper, /dispatch_get_main_queue\(\)/)
assert.match(activityHelper, /g_surfaces\.begin\(\)/)
assert.match(activityHelper, /const bool hasLiveSurface = std::any_of/)
assert.match(activityHelper, /return entry\.surface != nullptr;/)
assert.match(activityHelper, /const bool hasAttachedVisibleSurface = std::any_of/)
assert.match(
  activityHelper,
  /entry\.surface == nullptr \|\| !entry\.isAttached \|\| entry\.view == nil/
)
assert.match(activityHelper, /NSWindow\* window = entry\.view\.window/)
assert.match(
  activityHelper,
  /\(window\.occlusionState & NSWindowOcclusionStateVisible\) != 0/,
  'attached surfaces must own visible-only power assertions only while their window is visible'
)
assert.match(
  activityHelper,
  /g_terminalLiveActivity = \[\[NSProcessInfo processInfo\]\s+beginActivityWithOptions:\(NSActivityUserInitiated \|\s+NSActivityIdleSystemSleepDisabled\)/,
  'every live surface, including a hidden one, must retain baseline non-throttling activity'
)
assert.match(
  activityHelper,
  /g_terminalVisibleLatencyActivity = \[\[NSProcessInfo processInfo\]\s+beginActivityWithOptions:NSActivityLatencyCritical/,
  'latency-critical activity must be owned separately by attached surfaces'
)
assert.match(activityHelper, /endActivity:g_terminalVisibleLatencyActivity/)
assert.match(activityHelper, /endActivity:g_terminalLiveActivity/)
assert.match(
  activityHelper,
  /reconcileTerminalSafetyTimer\(hasAttachedVisibleSurface\)/,
  'the damage timer must share the same actual-visibility lifecycle'
)
assert.ok(
  activityHelper.indexOf('endActivity:g_terminalVisibleLatencyActivity') <
    activityHelper.indexOf('g_terminalVisibleLatencyActivity = nil'),
  'visible latency activity must end before releasing its ownership token'
)
assert.ok(
  activityHelper.indexOf('endActivity:g_terminalLiveActivity') <
    activityHelper.indexOf('g_terminalLiveActivity = nil'),
  'baseline live activity must end before releasing its ownership token'
)

const ensureApp = between('static bool ensureApp()', '// NAPI: mount')
assert.doesNotMatch(
  ensureApp,
  /beginActivityWithOptions:/,
  'Ghostty initialization must not acquire a process-lifetime activity'
)
assert.doesNotMatch(
  ensureApp,
  /timerWithTimeInterval:/,
  'Ghostty initialization must not create a process-lifetime damage timer'
)

const safetyTimerHelper = between(
  'static void reconcileTerminalSafetyTimer(bool hasAttachedVisibleSurface) {',
  'static void tick_async_cb'
)
assert.match(safetyTimerHelper, /hasAttachedVisibleSurface && !g_terminalSafetyTimer/)
assert.match(safetyTimerHelper, /timerWithTimeInterval:0\.1/)
assert.match(safetyTimerHelper, /forMode:NSRunLoopCommonModes/)
assert.match(safetyTimerHelper, /entry\.surface != nullptr/)
assert.match(safetyTimerHelper, /entry\.isAttached/)
assert.match(
  safetyTimerHelper,
  /\(window\.occlusionState & NSWindowOcclusionStateVisible\) != 0/,
  'the safety timer must never draw an attached but occluded surface'
)
assert.ok(
  safetyTimerHelper.indexOf('[g_terminalSafetyTimer invalidate]') <
    safetyTimerHelper.indexOf('g_terminalSafetyTimer = nil'),
  'the safety timer must be invalidated before releasing its ownership token'
)

const occlusionHandler = between(
  '- (void)handleOcclusionChange:(NSNotification*)note {',
  '// Fire callback to JS'
)
assert.ok(
  occlusionHandler.indexOf('reconcileTerminalActivities();') <
    occlusionHandler.indexOf('if (!g_occlusionTSFNActive) return;'),
  'native power state must reconcile on occlusion even without a JS listener'
)

const reconcileSurface = between(
  'static void reconcileSurface(const std::string& workspaceId, NSView* contentView, bool forceWake) {',
  '// setVisibleWorkspace'
)
assert.match(reconcileSurface, /entry\.isAttached = YES;/)
assert.match(reconcileSurface, /entry\.isAttached = NO;/)
assert.match(
  reconcileSurface,
  /reconcileTerminalActivities\(\);\s*}/,
  'every attach/detach reconciliation must refresh native activity ownership'
)

const destroy = between('static Napi::Value Destroy(', 'static Napi::Value SendInput(')
assert.ok(
  destroy.indexOf('g_surfaces.erase(it)') < destroy.indexOf('reconcileTerminalActivities();'),
  'destroy must remove the surface before checking whether activity can end'
)
assert.ok(
  destroy.indexOf('[doomed.view removeFromSuperview]') <
    destroy.indexOf('reconcileTerminalActivities();'),
  'destroy must detach the native view before releasing activity'
)

const hide = between('static Napi::Value Hide(', '// NAPI: resize')
assert.doesNotMatch(
  hide,
  /ghostty_surface_free/,
  'releasing visible-only latency activity must not tear down hidden shells'
)

console.log('Native terminal idle-activity verification passed.')
