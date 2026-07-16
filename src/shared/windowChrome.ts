// ---------------------------------------------------------------------------
// Window chrome geometry
// ---------------------------------------------------------------------------

// macOS traffic-light geometry. The lights are positioned by Electron via
// BrowserWindow `trafficLightPosition` (see src/main/index.ts) and sit at a
// fixed window offset that does NOT change when the sidebar collapses.

/** Left inset of the traffic-light cluster — mirrors trafficLightPosition.x. */
export const TRAFFIC_LIGHT_INSET = 16
/** Span of the three macOS window buttons (≈14px buttons, ≈20px centers). */
const TRAFFIC_LIGHT_CLUSTER_WIDTH = 54
/** Breathing room between the last light and the first top-bar control. */
const TRAFFIC_LIGHT_GUTTER = 18
/** Total width the top-bar must reserve before its first interactive control. */
export const TRAFFIC_LIGHT_CLEARANCE =
  TRAFFIC_LIGHT_INSET + TRAFFIC_LIGHT_CLUSTER_WIDTH + TRAFFIC_LIGHT_GUTTER // 88
