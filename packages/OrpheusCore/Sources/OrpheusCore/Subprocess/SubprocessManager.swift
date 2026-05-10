import Foundation
import os.log

// Note: Phase 1 spawns processes via Foundation.Process with regular Pipes.
// Phase 2 will replace the Pipes with a forkpty-backed PTY managed by
// libghostty. The public surface (spawn/terminate/processes/SpawnResult)
// stays the same.

// MARK: - StdinHandle

/// A typed, actor-isolated wrapper around the write end of a subprocess stdin pipe.
public actor StdinHandle {
    private var fileHandle: FileHandle?
    private var closed = false

    internal init(fileHandle: FileHandle) {
        self.fileHandle = fileHandle
    }

    /// Write `data` to the subprocess's stdin.
    ///
    /// - Throws: `OrpheusCoreError.subprocessSpawn(reason:)` if stdin has been closed.
    public func write(_ data: Data) async throws {
        guard !closed, let fh = fileHandle else {
            throw OrpheusCoreError.subprocessSpawn(reason: "stdin closed")
        }
        fh.write(data)
    }

    /// Close stdin, signalling EOF to the child process.
    public func close() async {
        guard !closed else { return }
        closed = true
        fileHandle?.closeFile()
        fileHandle = nil
    }
}

// MARK: - SpawnResult

/// The result of a successful `SubprocessManager.spawn` call.
public struct SpawnResult: Sendable {
    /// A snapshot record of the spawned process.
    public let process: ClaudeProcess

    /// A stream of raw data chunks from the process's stdout.
    /// An empty `Data` chunk signals EOF.
    public let stdout: AsyncStream<Data>

    /// A stream of raw data chunks from the process's stderr.
    /// An empty `Data` chunk signals EOF.
    public let stderr: AsyncStream<Data>

    /// Lifecycle events for the process (`.spawned`, `.exited`).
    public let events: AsyncStream<ProcessEvent>

    /// Actor-isolated write handle for the process's stdin.
    public let stdin: StdinHandle
}

// MARK: - Pipe state box

/// A thread-safe box that bridges `readabilityHandler` dispatch-queue callbacks
/// into `AsyncStream` continuations without actor-isolation races.
private final class PipeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: AsyncStream<Data>.Continuation?

    init(continuation: AsyncStream<Data>.Continuation) {
        self.continuation = continuation
    }

    func yield(_ data: Data) {
        _ = lock.withLock { continuation?.yield(data) }
    }

    func finish() {
        lock.withLock {
            continuation?.finish()
            continuation = nil
        }
    }
}

// MARK: - Events box

/// Thread-safe box for the events stream continuation.
private final class EventsBox: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: AsyncStream<ProcessEvent>.Continuation?

    init(continuation: AsyncStream<ProcessEvent>.Continuation) {
        self.continuation = continuation
    }

    func yield(_ event: ProcessEvent) {
        _ = lock.withLock { continuation?.yield(event) }
    }

    func finish() {
        lock.withLock {
            continuation?.finish()
            continuation = nil
        }
    }
}

// MARK: - Internal process record

private struct ProcessRecord {
    let process: Process
    let snapshot: ClaudeProcess
    let stdoutBox: PipeBox
    let stderrBox: PipeBox
    let eventsBox: EventsBox
    let stdinHandle: StdinHandle
}

// MARK: - SubprocessManager

/// Actor-isolated manager for subprocesses.
///
/// Spawns binaries (including `claude`) via `Foundation.Process` with Pipe-based
/// stdio. Tracks live processes and emits lifecycle events.
public actor SubprocessManager {

    // MARK: State

    private var records: [ProcessHandle: ProcessRecord] = [:]

    // MARK: Lifecycle

    public init() {}

    // MARK: - Spawn

    /// Spawn a binary and return a snapshot + live stdio/event streams.
    ///
    /// - Parameters:
    ///   - binaryPath: Absolute path to the executable.
    ///   - arguments: Arguments to pass to the binary.
    ///   - cwd: Working directory for the spawned process.
    ///   - environment: Optional environment dictionary. If `nil`, inherits the
    ///     current process environment.
    /// - Returns: A `SpawnResult` containing the process snapshot and streams.
    /// - Throws: `OrpheusCoreError.subprocessSpawn` on failure.
    public func spawn(
        binaryPath: String,
        arguments: [String],
        cwd: URL,
        environment: [String: String]? = nil
    ) async throws -> SpawnResult {

        // Build streams upfront so continuations are captured before run().
        var stdoutContinuation: AsyncStream<Data>.Continuation!
        var stderrContinuation: AsyncStream<Data>.Continuation!
        var eventsContinuation: AsyncStream<ProcessEvent>.Continuation!

        let stdoutStream = AsyncStream<Data> { cont in stdoutContinuation = cont }
        let stderrStream = AsyncStream<Data> { cont in stderrContinuation = cont }
        let eventsStream = AsyncStream<ProcessEvent> { cont in eventsContinuation = cont }

        let stdoutBox = PipeBox(continuation: stdoutContinuation)
        let stderrBox = PipeBox(continuation: stderrContinuation)
        let eventsBox = EventsBox(continuation: eventsContinuation)

        // Create pipes.
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        let stdinPipe  = Pipe()

        // Configure the process.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binaryPath)
        process.arguments = arguments
        process.currentDirectoryURL = cwd
        process.standardOutput = stdoutPipe
        process.standardError  = stderrPipe
        process.standardInput  = stdinPipe
        if let env = environment {
            process.environment = env
        }

        // CRITICAL: Set readability handlers BEFORE calling run().
        // Foundation.Process deadlocks if its pipes fill with no reader.

        stdoutPipe.fileHandleForReading.readabilityHandler = { [stdoutBox] fh in
            let data = fh.availableData
            if data.isEmpty {
                // EOF — signal and remove handler to avoid repeated callbacks.
                fh.readabilityHandler = nil
                stdoutBox.yield(Data())
                stdoutBox.finish()
            } else {
                stdoutBox.yield(data)
            }
        }

        stderrPipe.fileHandleForReading.readabilityHandler = { [stderrBox] fh in
            let data = fh.availableData
            if data.isEmpty {
                fh.readabilityHandler = nil
                stderrBox.yield(Data())
                stderrBox.finish()
            } else {
                stderrBox.yield(data)
            }
        }

        // Termination handler.
        process.terminationHandler = { [eventsBox, stdoutBox, stderrBox] proc in
            let status = Self.makeExitStatus(from: proc)
            let handle = ProcessHandle(rawValue: proc.processIdentifier)

            // Finish stdout/stderr boxes in case readabilityHandler hasn't fired EOF yet.
            stdoutBox.finish()
            stderrBox.finish()

            eventsBox.yield(.exited(handle, status))
            eventsBox.finish()

            OrpheusLogger.subprocess.debug(
                "Process \(handle.rawValue, privacy: .public) exited: \(String(describing: status), privacy: .public)"
            )
        }

        // Launch.
        do {
            try process.run()
        } catch {
            // Clean up handlers on failure.
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            throw OrpheusCoreError.subprocessSpawn(reason: error.localizedDescription)
        }

        let handle = ProcessHandle(rawValue: process.processIdentifier)
        let stdinHandle = StdinHandle(fileHandle: stdinPipe.fileHandleForWriting)

        let snapshot = ClaudeProcess(
            handle: handle,
            command: binaryPath,
            arguments: arguments,
            cwd: cwd,
            startedAt: Date()
        )

        // Store record.
        let record = ProcessRecord(
            process: process,
            snapshot: snapshot,
            stdoutBox: stdoutBox,
            stderrBox: stderrBox,
            eventsBox: eventsBox,
            stdinHandle: stdinHandle
        )
        records[handle] = record

        // Schedule removal from records map once the process exits.
        // We do this by observing the termination — the terminationHandler above
        // fires on a background queue. We remove from the map when polled via
        // processes(), or eagerly by launching a monitoring task.
        let selfRef = self
        Task {
            // Wait for process to stop being running.
            while process.isRunning {
                try? await Task.sleep(nanoseconds: 50_000_000) // 50 ms poll
            }
            await selfRef.removeRecord(for: handle)
        }

        eventsBox.yield(.spawned(handle))

        OrpheusLogger.subprocess.info(
            "Spawned \(binaryPath, privacy: .public) pid=\(handle.rawValue, privacy: .public)"
        )

        return SpawnResult(
            process: snapshot,
            stdout: stdoutStream,
            stderr: stderrStream,
            events: eventsStream,
            stdin: stdinHandle
        )
    }

    // MARK: - Terminate

    /// Terminate a running process.
    ///
    /// Sends SIGTERM immediately. If the process has not exited within `timeout`
    /// seconds, sends SIGKILL. Returns immediately — the actual exit is reported
    /// via the `events` stream.
    ///
    /// - Parameters:
    ///   - id: Handle of the process to terminate.
    ///   - timeout: Seconds to wait before escalating to SIGKILL.
    /// - Throws: `OrpheusCoreError.notFound` if `id` is not tracked.
    public func terminate(_ id: ProcessHandle, timeout: TimeInterval = 5.0) async throws {
        guard let record = records[id] else {
            throw OrpheusCoreError.notFound(id: id.description, kind: "process")
        }

        let process = record.process
        guard process.isRunning else { return }

        process.terminate() // SIGTERM

        OrpheusLogger.subprocess.info(
            "Sent SIGTERM to pid=\(id.rawValue, privacy: .public)"
        )

        // Schedule SIGKILL escalation without blocking the caller.
        let pid = id.rawValue
        let timeoutNS = UInt64(timeout * 1_000_000_000)
        Task.detached {
            try? await Task.sleep(nanoseconds: timeoutNS)
            // Re-check: the process may have exited by now.
            if process.isRunning {
                kill(pid, SIGKILL)
                OrpheusLogger.subprocess.warning(
                    "Sent SIGKILL to pid=\(pid, privacy: .public) after timeout"
                )
            }
        }
    }

    // MARK: - Processes snapshot

    /// Returns a snapshot of all currently-tracked live processes.
    public func processes() async -> [ClaudeProcess] {
        // Eagerly clean up exited processes.
        let exited = records.filter { !$0.value.process.isRunning }.map(\.key)
        for key in exited { records.removeValue(forKey: key) }

        return records.values.map(\.snapshot)
    }

    // MARK: - Internal

    private func removeRecord(for handle: ProcessHandle) {
        records.removeValue(forKey: handle)
    }

    // MARK: - ExitStatus helper

    private static func makeExitStatus(from process: Process) -> ExitStatus {
        switch process.terminationReason {
        case .exit:
            return .exit(process.terminationStatus)
        case .uncaughtSignal:
            let sig = process.terminationStatus
            if sig > 0 {
                return .signal(sig)
            } else {
                return .uncaughtException
            }
        @unknown default:
            return .uncaughtException
        }
    }
}
