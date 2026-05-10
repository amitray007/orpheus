import XCTest
import Foundation
@testable import OrpheusCore

// MARK: - Helpers

/// Collect all Data chunks from `stream` until EOF (empty Data) or `timeout`
/// elapses. Concatenates chunks (excluding the empty EOF sentinel) into a
/// single Data blob. Uses withTaskGroup so we never block on `for await`
/// indefinitely.
private func collectStdout(
    from stream: AsyncStream<Data>,
    timeout: Double
) async -> Data {
    final class Collector: @unchecked Sendable {
        let lock = NSLock()
        var data = Data()
        func append(_ d: Data) { lock.withLock { data.append(d) } }
    }
    let collector = Collector()

    await withTaskGroup(of: Void.self) { group in
        group.addTask {
            for await chunk in stream {
                if chunk.isEmpty { break }          // EOF sentinel
                collector.append(chunk)
            }
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
        }
        await group.next()
        group.cancelAll()
    }
    return collector.data
}

/// Return the first `ProcessEvent` from `stream` within `timeout`, or nil.
private func firstEvent(
    from stream: AsyncStream<ProcessEvent>,
    timeout: Double
) async -> ProcessEvent? {
    await withTaskGroup(of: ProcessEvent?.self) { group in
        group.addTask {
            for await event in stream { return event }
            return nil
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            return nil
        }
        let result = await group.next() ?? nil
        group.cancelAll()
        return result
    }
}

/// Collect all ProcessEvents from `stream` within `timeout`, returning them in order.
private func collectEvents(
    from stream: AsyncStream<ProcessEvent>,
    timeout: Double
) async -> [ProcessEvent] {
    final class EventStore: @unchecked Sendable {
        let lock = NSLock()
        var events: [ProcessEvent] = []
        func append(_ e: ProcessEvent) { lock.withLock { events.append(e) } }
    }
    let store = EventStore()

    await withTaskGroup(of: Void.self) { group in
        group.addTask {
            for await event in stream {
                store.append(event)
            }
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
        }
        await group.next()
        group.cancelAll()
    }
    return store.events
}

// MARK: - Tests

final class SubprocessManagerTests: XCTestCase {

    // MARK: - echo "hello"

    func testEchoProducesHelloNewline() async throws {
        let manager = SubprocessManager()
        let result = try await manager.spawn(
            binaryPath: "/bin/echo",
            arguments: ["hello"],
            cwd: URL(fileURLWithPath: "/tmp")
        )
        let handle = result.process.id

        defer {
            Task { try? await manager.terminate(handle) }
        }

        let data = await collectStdout(from: result.stdout, timeout: 5.0)
        let text = String(data: data, encoding: .utf8)
        XCTAssertEqual(text, "hello\n")
    }

    // MARK: - /usr/bin/true exits 0

    func testTrueExitsWithCode0() async throws {
        let manager = SubprocessManager()
        let result = try await manager.spawn(
            binaryPath: "/usr/bin/true",
            arguments: [],
            cwd: URL(fileURLWithPath: "/tmp")
        )
        let handle = result.process.id

        defer {
            Task { try? await manager.terminate(handle) }
        }

        let events = await collectEvents(from: result.events, timeout: 5.0)
        let exitEvent = events.first { if case .exited = $0 { return true }; return false }
        guard let exit = exitEvent else {
            XCTFail("No exit event received within timeout")
            return
        }
        if case .exited(_, let status) = exit {
            XCTAssertEqual(status, .exit(0))
        } else {
            XCTFail("Unexpected event: \(exit)")
        }
    }

    // MARK: - /usr/bin/false exits 1

    func testFalseExitsWithCode1() async throws {
        let manager = SubprocessManager()
        let result = try await manager.spawn(
            binaryPath: "/usr/bin/false",
            arguments: [],
            cwd: URL(fileURLWithPath: "/tmp")
        )
        let handle = result.process.id

        defer {
            Task { try? await manager.terminate(handle) }
        }

        let events = await collectEvents(from: result.events, timeout: 5.0)
        let exitEvent = events.first { if case .exited = $0 { return true }; return false }
        guard let exit = exitEvent else {
            XCTFail("No exit event received within timeout")
            return
        }
        if case .exited(_, let status) = exit {
            XCTAssertEqual(status, .exit(1))
        } else {
            XCTFail("Unexpected event: \(exit)")
        }
    }

    // MARK: - /bin/cat stdin → stdout

    func testCatEchoesStdinToStdout() async throws {
        let manager = SubprocessManager()
        let result = try await manager.spawn(
            binaryPath: "/bin/cat",
            arguments: [],
            cwd: URL(fileURLWithPath: "/tmp")
        )
        let handle = result.process.id

        defer {
            Task { try? await manager.terminate(handle) }
        }

        // Write "line\n" then close stdin.
        let inputData = "line\n".data(using: .utf8)!
        try await result.stdin.write(inputData)
        await result.stdin.close()

        let data = await collectStdout(from: result.stdout, timeout: 5.0)
        let text = String(data: data, encoding: .utf8)
        XCTAssertEqual(text, "line\n")
    }

    // MARK: - StdinHandle: write after close throws

    func testStdinWriteAfterCloseThrows() async throws {
        let manager = SubprocessManager()
        let result = try await manager.spawn(
            binaryPath: "/bin/cat",
            arguments: [],
            cwd: URL(fileURLWithPath: "/tmp")
        )
        let handle = result.process.id

        defer {
            Task { try? await manager.terminate(handle) }
        }

        await result.stdin.close()

        do {
            try await result.stdin.write("oops".data(using: .utf8)!)
            XCTFail("Expected error after close")
        } catch let error as OrpheusCoreError {
            if case .subprocessSpawn(let reason) = error {
                XCTAssertTrue(reason.contains("stdin closed"), "Unexpected reason: \(reason)")
            } else {
                XCTFail("Wrong error: \(error)")
            }
        }
    }

    // MARK: - Terminate with SIGTERM

    func testTerminateSendsSigterm() async throws {
        let manager = SubprocessManager()
        let result = try await manager.spawn(
            binaryPath: "/bin/sleep",
            arguments: ["30"],
            cwd: URL(fileURLWithPath: "/tmp")
        )
        let handle = result.process.id

        // Terminate right away; give it 1 s to die.
        try await manager.terminate(handle, timeout: 5.0)

        let events = await collectEvents(from: result.events, timeout: 3.0)
        let exitEvent = events.first { if case .exited = $0 { return true }; return false }
        guard let exit = exitEvent else {
            XCTFail("Process did not exit within 3 s after SIGTERM")
            return
        }

        if case .exited(_, let status) = exit {
            // SIGTERM is signal 15.
            XCTAssertEqual(status, .signal(SIGTERM), "Expected signal 15, got \(status)")
        } else {
            XCTFail("Unexpected event: \(exit)")
        }
    }

    // MARK: - Terminate unknown handle throws notFound

    func testTerminateUnknownHandleThrows() async throws {
        let manager = SubprocessManager()
        let ghost = ProcessHandle(rawValue: 99999)
        do {
            try await manager.terminate(ghost)
            XCTFail("Expected notFound error")
        } catch let error as OrpheusCoreError {
            if case .notFound(let id, let kind) = error {
                XCTAssertEqual(kind, "process")
                XCTAssertEqual(id, "99999")
            } else {
                XCTFail("Wrong error: \(error)")
            }
        }
    }

    // MARK: - processes() snapshot

    func testProcessesSnapshotIncludesRunningProcess() async throws {
        let manager = SubprocessManager()
        let result = try await manager.spawn(
            binaryPath: "/bin/sleep",
            arguments: ["10"],
            cwd: URL(fileURLWithPath: "/tmp")
        )
        let handle = result.process.id

        defer {
            Task { try? await manager.terminate(handle) }
        }

        let snapshot = await manager.processes()
        XCTAssertTrue(
            snapshot.contains(where: { $0.id == handle }),
            "Running process should appear in processes() snapshot"
        )
    }

    func testProcessesSnapshotExcludesExitedProcess() async throws {
        let manager = SubprocessManager()
        let result = try await manager.spawn(
            binaryPath: "/usr/bin/true",
            arguments: [],
            cwd: URL(fileURLWithPath: "/tmp")
        )
        let handle = result.process.id

        // Wait for exit.
        _ = await collectEvents(from: result.events, timeout: 5.0)

        // Give the polling task a moment to clean up.
        try await Task.sleep(nanoseconds: 200_000_000) // 200 ms

        let snapshot = await manager.processes()
        XCTAssertFalse(
            snapshot.contains(where: { $0.id == handle }),
            "Exited process should not appear in processes() snapshot"
        )
    }

    // MARK: - Spawned event is emitted

    func testSpawnedEventIsEmitted() async throws {
        let manager = SubprocessManager()
        let result = try await manager.spawn(
            binaryPath: "/bin/sleep",
            arguments: ["10"],
            cwd: URL(fileURLWithPath: "/tmp")
        )
        let handle = result.process.id

        defer {
            Task { try? await manager.terminate(handle) }
        }

        // The .spawned event should be the first event in the stream.
        let event = await firstEvent(from: result.events, timeout: 2.0)
        guard let event else {
            XCTFail("No event received within timeout")
            return
        }
        if case .spawned(let h) = event {
            XCTAssertEqual(h, handle)
        } else {
            XCTFail("Expected .spawned, got \(event)")
        }
    }

    // MARK: - ClaudeProcess snapshot correctness

    func testProcessSnapshotHasCorrectFields() async throws {
        let manager = SubprocessManager()
        let cwd = URL(fileURLWithPath: "/tmp")
        let result = try await manager.spawn(
            binaryPath: "/bin/sleep",
            arguments: ["10"],
            cwd: cwd
        )
        let handle = result.process.id

        defer {
            Task { try? await manager.terminate(handle) }
        }

        let proc = result.process
        XCTAssertEqual(proc.command, "/bin/sleep")
        XCTAssertEqual(proc.arguments, ["10"])
        XCTAssertEqual(proc.cwd, cwd)
        XCTAssertEqual(proc.pid, handle.rawValue)
        XCTAssertGreaterThan(proc.pid, 0)
    }

    // MARK: - ProcessHandle CustomStringConvertible

    func testProcessHandleDescription() {
        let handle = ProcessHandle(rawValue: 12345)
        XCTAssertEqual(handle.description, "12345")
    }

    // MARK: - ProcessHandle Hashable / Equatable

    func testProcessHandleHashableEquatable() {
        let a = ProcessHandle(rawValue: 42)
        let b = ProcessHandle(rawValue: 42)
        let c = ProcessHandle(rawValue: 99)
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
        let set: Set<ProcessHandle> = [a, b, c]
        XCTAssertEqual(set.count, 2)
    }

    // MARK: - ExitStatus Equatable

    func testExitStatusEquatable() {
        XCTAssertEqual(ExitStatus.exit(0), ExitStatus.exit(0))
        XCTAssertNotEqual(ExitStatus.exit(0), ExitStatus.exit(1))
        XCTAssertEqual(ExitStatus.signal(15), ExitStatus.signal(15))
        XCTAssertNotEqual(ExitStatus.signal(15), ExitStatus.signal(9))
        XCTAssertEqual(ExitStatus.uncaughtException, ExitStatus.uncaughtException)
        XCTAssertNotEqual(ExitStatus.exit(0), ExitStatus.signal(0))
    }
}
