import XCTest
import Foundation
@testable import OrpheusCore

final class FileChangeWatcherTests: XCTestCase {

    private var tmpDir: URL!

    override func setUp() async throws {
        tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("FileChangeWatcherTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // MARK: - Helpers

    private func touch(_ url: URL, content: String = "x") throws {
        try content.data(using: .utf8)!.write(to: url, options: .atomic)
    }

    // MARK: - Basic emission

    func testFileChangeEmitsEvent() async throws {
        let url = tmpDir.appendingPathComponent("watch.txt")
        try touch(url)

        let watcher = FileChangeWatcher(path: url.path)
        let stream = await watcher.events()

        // Give the watcher a moment to register the dispatch source.
        try await Task.sleep(nanoseconds: 100_000_000)  // 100 ms

        // Mutate the file.
        try touch(url, content: "changed")

        // Collect the first event within 1.5 s.
        let received = await collectFirst(from: stream, timeout: 1.5)
        XCTAssertTrue(received, "Expected a file change event")

        await watcher.stop()
    }

    // MARK: - Debounce coalescing

    func testMultipleRapidWritesProduceSingleEmission() async throws {
        let url = tmpDir.appendingPathComponent("debounce.txt")
        try touch(url)

        let watcher = FileChangeWatcher(path: url.path, debounce: 0.200)
        let stream = await watcher.events()

        // Give watcher time to register.
        try await Task.sleep(nanoseconds: 100_000_000)

        // Fire 3 rapid writes within the debounce window.
        for i in 0..<3 {
            try touch(url, content: "write-\(i)")
            try await Task.sleep(nanoseconds: 30_000_000)  // 30 ms apart
        }

        // Count events arriving in ~600 ms (well past the 200 ms debounce).
        let count = await countEvents(from: stream, duration: 0.600)

        // Should be 1 (possibly 2 with boundary timing), definitely not 3.
        XCTAssertLessThanOrEqual(count, 2, "Debounce should coalesce rapid writes")
        XCTAssertGreaterThanOrEqual(count, 1, "Should have emitted at least once")

        await watcher.stop()
    }

    // MARK: - File doesn't exist at start time (polling path)

    func testFileAppearsAfterStartEmitsEvent() async throws {
        let url = tmpDir.appendingPathComponent("late-appear.txt")
        // Deliberately do NOT create the file before starting.
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))

        let watcher = FileChangeWatcher(path: url.path, debounce: 0.100)
        let stream = await watcher.events()

        // Wait briefly then create the file.
        try await Task.sleep(nanoseconds: 300_000_000)  // 300 ms
        try touch(url, content: "appeared")

        // Expect an event within 3 s (poll interval 1 s + debounce + slack).
        let received = await collectFirst(from: stream, timeout: 3.0)
        XCTAssertTrue(received, "Watcher should emit after file appears")

        await watcher.stop()
    }

    // MARK: - File deletion + re-creation

    func testFileDeletionAndRecreationEmitsAgain() async throws {
        let url = tmpDir.appendingPathComponent("recreate.txt")
        try touch(url)

        let watcher = FileChangeWatcher(path: url.path, debounce: 0.100)
        let stream = await watcher.events()

        // Allow watcher to register.
        try await Task.sleep(nanoseconds: 150_000_000)

        // Delete the file.
        try FileManager.default.removeItem(at: url)

        // Wait for watcher to detect deletion and enter poll mode.
        try await Task.sleep(nanoseconds: 1_500_000_000)  // 1.5 s

        // Re-create the file.
        try touch(url, content: "recreated")

        // Expect emission within 3 s.
        let received = await collectFirst(from: stream, timeout: 3.0)
        XCTAssertTrue(received, "Watcher should emit after file is re-created")

        await watcher.stop()
    }

    // MARK: - Stop finishes the stream

    func testStopFinishesStream() async throws {
        let url = tmpDir.appendingPathComponent("stop.txt")
        try touch(url)

        let watcher = FileChangeWatcher(path: url.path)
        let stream = await watcher.events()

        await watcher.stop()

        // After stop(), iterating should terminate (not hang forever).
        var count = 0
        for await _ in stream {
            count += 1
            if count > 5 { break }  // safety valve
        }
        // count may be 0 or small; the important thing is we didn't hang.
    }
}

// MARK: - Helpers

/// Collect events for `duration` seconds and return how many arrived.
///
/// Races the stream against a sleep timer so a low-event-rate stream cannot
/// block the test indefinitely waiting for the next emission.
private func countEvents(from stream: AsyncStream<Void>, duration: Double) async -> Int {
    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        func inc() { lock.withLock { n += 1 } }
        var value: Int { lock.withLock { n } }
    }
    let counter = Counter()

    await withTaskGroup(of: Void.self) { group in
        group.addTask {
            for await _ in stream {
                counter.inc()
            }
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
        }
        // First task to complete (the timer) returns; cancel the consumer.
        await group.next()
        group.cancelAll()
    }
    return counter.value
}

/// Returns `true` if at least one event arrives within `timeout` seconds.
private func collectFirst(from stream: AsyncStream<Void>, timeout: Double) async -> Bool {
    await withTaskGroup(of: Bool.self) { group in
        group.addTask {
            for await _ in stream { return true }
            return false
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            return false
        }
        let result = await group.next() ?? false
        group.cancelAll()
        return result
    }
}
