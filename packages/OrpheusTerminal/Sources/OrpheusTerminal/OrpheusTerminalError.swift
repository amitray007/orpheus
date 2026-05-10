import Foundation

public enum OrpheusTerminalError: Error, Sendable, Equatable, LocalizedError {
    case engineInitFailed(reason: String)
    case surfaceCreationFailed(reason: String)
    case paletteApplyFailed(key: String, reason: String)
    case commandSpawnFailed(command: String, reason: String)

    public var errorDescription: String? {
        switch self {
        case let .engineInitFailed(reason):
            "OrpheusTerminal engine failed to initialise: \(reason)"
        case let .surfaceCreationFailed(reason):
            "OrpheusTerminal surface creation failed: \(reason)"
        case let .paletteApplyFailed(key, reason):
            "OrpheusTerminal palette apply failed for key '\(key)': \(reason)"
        case let .commandSpawnFailed(command, reason):
            "OrpheusTerminal command spawn failed for '\(command)': \(reason)"
        }
    }
}
