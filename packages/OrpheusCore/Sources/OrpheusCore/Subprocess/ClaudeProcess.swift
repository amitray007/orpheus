import Foundation

// MARK: - ProcessHandle

/// A strongly-typed wrapper around a process identifier (pid_t).
public struct ProcessHandle: Hashable, Sendable, Codable, CustomStringConvertible {
    public let rawValue: Int32

    public init(rawValue: Int32) {
        self.rawValue = rawValue
    }

    public var description: String { String(rawValue) }
}

// MARK: - ClaudeProcess

/// A snapshot record of a spawned subprocess.
///
/// This is a value type — it captures state at spawn time.
/// The live `Foundation.Process` is held inside `SubprocessManager`'s
/// actor-isolated state, not here.
public struct ClaudeProcess: Sendable, Identifiable {
    /// Unique identity of the process, typed around the pid.
    public let id: ProcessHandle

    /// The raw process identifier.
    public let pid: Int32

    /// Resolved path to the binary that was launched.
    public let command: String

    /// Arguments passed to the binary.
    public let arguments: [String]

    /// Working directory of the spawned process.
    public let cwd: URL

    /// Wall-clock time at which the process was spawned.
    public let startedAt: Date

    internal init(
        handle: ProcessHandle,
        command: String,
        arguments: [String],
        cwd: URL,
        startedAt: Date
    ) {
        self.id = handle
        self.pid = handle.rawValue
        self.command = command
        self.arguments = arguments
        self.cwd = cwd
        self.startedAt = startedAt
    }
}
