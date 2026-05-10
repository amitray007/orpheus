import Foundation

/// An event emitted by `SessionRegistry` whenever the session index changes.
///
/// Consumers subscribe to `SessionRegistry.updates()` and react to each
/// case to keep UI representations in sync with the on-disk JSONL files.
public enum SessionUpdate: Sendable {
    /// A new JSONL file appeared, or a session was discovered for the first
    /// time during the initial scan.
    case added(SessionMetadata)

    /// An existing JSONL file was modified; the metadata has changed.
    case updated(SessionMetadata)

    /// A JSONL file was deleted; only the session ID is available.
    case removed(SessionID)
}
