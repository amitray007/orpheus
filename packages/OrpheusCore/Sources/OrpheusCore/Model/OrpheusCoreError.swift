import Foundation

public enum OrpheusCoreError: Error, Sendable, Equatable {
    case notFound(id: String, kind: String)
    case invalidParent(child: String, parent: String)
    case migrationFailed(reason: String)
    case subprocessSpawn(reason: String)
    case corruptJSONL(path: String, line: Int)
    case settingsMergeConflict(key: String)
}

extension OrpheusCoreError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .notFound(let id, let kind):
            return "\(kind) with id '\(id)' not found."
        case .invalidParent(let child, let parent):
            return "'\(child)' has an invalid parent: '\(parent)'."
        case .migrationFailed(let reason):
            return "Database migration failed: \(reason)"
        case .subprocessSpawn(let reason):
            return "Failed to spawn subprocess: \(reason)"
        case .corruptJSONL(let path, let line):
            return "Corrupt JSONL at \(path), line \(line)."
        case .settingsMergeConflict(let key):
            return "Settings merge conflict on key '\(key)'."
        }
    }
}
