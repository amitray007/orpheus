// Compatibility entry point for orphan handling. Listener inspection and
// proof-only reclamation live in inspection.ts so allocation can inject the
// same seam without coupling to the manager.
export {
  defaultListenerInspectionDeps,
  isSameVariantRoutingProxy,
  reclaimProvenOrphan,
  type ListenerInspectionDeps,
  type ListeningProcess
} from './inspection'
