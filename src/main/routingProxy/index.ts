// ---------------------------------------------------------------------------
// src/main/routingProxy/index.ts
//
// Barrel export for the managed routing-proxy component. Other main modules
// (ipc/routingProxy.ts, modelRouting.ts, index.ts's boot sequence) import
// from here rather than reaching into individual files.
// ---------------------------------------------------------------------------

export * from './constants'
export * from './paths'
export * from './manager'
export {
  checkRoutingProxyHealth,
  ensureHealthyForRouting as ensureHealthyForRoutingRaw
} from './health'
export { getManagementSecret } from './lifecycle'
