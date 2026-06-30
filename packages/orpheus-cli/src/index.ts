/**
 * @orpheus/cli entry point.
 *
 * This module re-exports the public API surface of the CLI foundation.
 * Command implementations are added in later units.
 */

export { getUserDataDir, getSqlitePath, getCmdSockPath, getCmdTokenPath } from './paths.js'
export {
  resolveContext,
  noProjectMessage,
  type ResolvedContext,
  type ResolveContextOpts,
  type ContextDb,
  type ProjectRow,
  type WorkspaceRow
} from './context.js'
