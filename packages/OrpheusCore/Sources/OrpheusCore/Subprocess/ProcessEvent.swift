import Foundation

// MARK: - ExitStatus

/// The exit status of a terminated subprocess.
public enum ExitStatus: Sendable, Equatable {
    /// Normal exit with the given exit code.
    case exit(Int32)

    /// Process was killed by a signal (e.g. SIGTERM = 15, SIGKILL = 9).
    case signal(Int32)

    /// Process terminated due to an uncaught signal in an unexpected way.
    case uncaughtException
}

// MARK: - ProcessEvent

/// Lifecycle events emitted by `SubprocessManager` for a spawned process.
public enum ProcessEvent: Sendable {
    /// The process was successfully launched.
    case spawned(ProcessHandle)

    /// The process has exited with the given status.
    case exited(ProcessHandle, ExitStatus)
}
