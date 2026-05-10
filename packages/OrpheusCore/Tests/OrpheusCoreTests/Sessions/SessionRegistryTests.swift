import XCTest
import Foundation
@testable import OrpheusCore

final class SessionRegistryTests: XCTestCase {

    private var tmpDir: URL!

    override func setUp() async throws {
        tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("SessionRegistryTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // MARK: - Helpers

    /// Create a project subdirectory and write a JSONL file into it.
    @discardableResult
    private func writeSession(
        projectDir: String,
        sessionId: String,
        cwd: String,
        gitBranch: String? = nil,
        name: String? = nil,
        lastUpdated: String = "2026-01-15T12:00:00.000Z",
        lastType: String = "assistant"
    ) throws -> URL {
        let dir = tmpDir.appendingPathComponent(projectDir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("\(sessionId).jsonl")

        var headerDict: [String: Any] = ["sessionId": sessionId, "cwd": cwd]
        if let b = gitBranch { headerDict["gitBranch"] = b }
        if let n = name { headerDict["name"] = n }
        let headerData = try JSONSerialization.data(withJSONObject: headerDict)
        let headerLine = String(data: headerData, encoding: .utf8)!

        let lastDict: [String: Any] = ["lastUpdated": lastUpdated, "type": lastType]
        let lastData = try JSONSerialization.data(withJSONObject: lastDict)
        let lastLine = String(data: lastData, encoding: .utf8)!

        let content = headerLine + "\n" + lastLine + "\n"
        try content.data(using: .utf8)!.write(to: file, options: .atomic)
        return file
    }

    // MARK: - Initial scan

    func testInitialScanDiscoversAllSessions() async throws {
        try writeSession(projectDir: "proj1", sessionId: "s1", cwd: "/work/proj1")
        try writeSession(projectDir: "proj1", sessionId: "s2", cwd: "/work/proj1")
        try writeSession(projectDir: "proj2", sessionId: "s3", cwd: "/work/proj2")

        let registry = SessionRegistry(rootURL: tmpDir)
        try await registry.start()

        let proj1Sessions = await registry.sessions(forCWD: "/work/proj1")
        XCTAssertEqual(proj1Sessions.count, 2)

        let proj2Sessions = await registry.sessions(forCWD: "/work/proj2")
        XCTAssertEqual(proj2Sessions.count, 1)
    }

    // MARK: - updates() receives initial scan snapshot

    func testUpdatesReceivesSnapshot() async throws {
        try writeSession(projectDir: "proj", sessionId: "s1", cwd: "/w/proj")
        try writeSession(projectDir: "proj", sessionId: "s2", cwd: "/w/proj")

        let registry = SessionRegistry(rootURL: tmpDir)
        let stream = await registry.updates()
        try await registry.start()

        let collected = await collectFirst(n: 2, from: stream, timeout: 3.0)
        XCTAssertEqual(collected.count, 2, "Should emit 2 added events from initial scan")

        // All events should be .added
        for update in collected {
            if case .added(_) = update { } else {
                XCTFail("Expected .added, got \(update)")
            }
        }

        await registry.stop()
    }

    // MARK: - Subscribe-first-then-start doesn't miss snapshot

    func testSubscribeFirstThenStart() async throws {
        try writeSession(projectDir: "proj", sessionId: "sid-1", cwd: "/x")

        let registry = SessionRegistry(rootURL: tmpDir)
        // Subscribe BEFORE start.
        let stream = await registry.updates()
        try await registry.start()

        let first = await firstValue(from: stream, timeout: 3.0)
        XCTAssertNotNil(first)
        if case .added(let m) = first! {
            XCTAssertEqual(m.sessionID.rawValue, "sid-1")
        } else {
            XCTFail("Expected .added")
        }

        await registry.stop()
    }

    // MARK: - recent(limit:)

    func testRecentReturnsCorrectOrder() async throws {
        // Write sessions with different lastUpdated timestamps.
        try writeSession(
            projectDir: "p",
            sessionId: "old",
            cwd: "/w",
            lastUpdated: "2025-01-01T00:00:00Z"
        )
        try writeSession(
            projectDir: "p",
            sessionId: "new",
            cwd: "/w",
            lastUpdated: "2026-06-01T00:00:00Z"
        )
        try writeSession(
            projectDir: "p",
            sessionId: "mid",
            cwd: "/w",
            lastUpdated: "2025-06-01T00:00:00Z"
        )

        let registry = SessionRegistry(rootURL: tmpDir)
        try await registry.start()

        let recent = await registry.recent(limit: 2)
        XCTAssertEqual(recent.count, 2)
        XCTAssertEqual(recent[0].sessionID.rawValue, "new")
        XCTAssertEqual(recent[1].sessionID.rawValue, "mid")

        await registry.stop()
    }

    // MARK: - search (in-memory fallback)

    func testSearchInMemoryFallback() async throws {
        try writeSession(projectDir: "p", sessionId: "s1", cwd: "/work/ios-app")
        try writeSession(projectDir: "p", sessionId: "s2", cwd: "/work/android-app", name: "Android Build")
        try writeSession(projectDir: "p", sessionId: "s3", cwd: "/work/backend")

        let registry = SessionRegistry(rootURL: tmpDir)
        try await registry.start()

        let results = try await registry.search("android", limit: 10)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].sessionID.rawValue, "s2")

        let allResults = try await registry.search("work", limit: 10)
        XCTAssertEqual(allResults.count, 3)

        await registry.stop()
    }

    // MARK: - Watcher detects new file

    func testWatcherDetectsNewFile() async throws {
        let registry = SessionRegistry(rootURL: tmpDir)
        let stream = await registry.updates()
        try await registry.start()

        // Allow the watcher to register (a bit of slack).
        try await Task.sleep(nanoseconds: 600_000_000)  // 600 ms

        // Write a new session file.
        try writeSession(projectDir: "live", sessionId: "live-1", cwd: "/live")

        // Expect an .added event within 3 s (DirectoryWatcher debounce + scan).
        let event = await firstValue(from: stream, timeout: 3.0)
        XCTAssertNotNil(event, "Expected a watcher event after writing new JSONL")

        await registry.stop()
    }

    // MARK: - stop() clears the index

    func testStopClearsIndex() async throws {
        try writeSession(projectDir: "proj", sessionId: "s1", cwd: "/c")

        let registry = SessionRegistry(rootURL: tmpDir)
        try await registry.start()

        let beforeStop = await registry.sessions(forCWD: "/c")
        XCTAssertEqual(beforeStop.count, 1)

        await registry.stop()

        let afterStop = await registry.sessions(forCWD: "/c")
        XCTAssertEqual(afterStop.count, 0)
    }

    // MARK: - Idempotent restart

    func testRestartRescans() async throws {
        try writeSession(projectDir: "p", sessionId: "s1", cwd: "/w")

        let registry = SessionRegistry(rootURL: tmpDir)
        try await registry.start()
        let first = await registry.sessions(forCWD: "/w")
        XCTAssertEqual(first.count, 1)

        // Write another session, then restart.
        try writeSession(projectDir: "p", sessionId: "s2", cwd: "/w")
        try await registry.start()

        let second = await registry.sessions(forCWD: "/w")
        XCTAssertEqual(second.count, 2)

        await registry.stop()
    }

    // MARK: - Empty root directory → no sessions

    func testEmptyRootNoSessions() async throws {
        let registry = SessionRegistry(rootURL: tmpDir)
        try await registry.start()

        let recent = await registry.recent(limit: 10)
        XCTAssertTrue(recent.isEmpty)

        await registry.stop()
    }

    // MARK: - sessions(forCWD:) returns only that CWD

    func testSessionsForCWDFiltersCorrectly() async throws {
        try writeSession(projectDir: "a", sessionId: "a1", cwd: "/cwd-a")
        try writeSession(projectDir: "b", sessionId: "b1", cwd: "/cwd-b")

        let registry = SessionRegistry(rootURL: tmpDir)
        try await registry.start()

        let forA = await registry.sessions(forCWD: "/cwd-a")
        XCTAssertEqual(forA.count, 1)
        XCTAssertEqual(forA[0].sessionID.rawValue, "a1")

        let forB = await registry.sessions(forCWD: "/cwd-b")
        XCTAssertEqual(forB.count, 1)
        XCTAssertEqual(forB[0].sessionID.rawValue, "b1")

        await registry.stop()
    }
}

// MARK: - Helpers

private func firstValue<T: Sendable>(
    from stream: AsyncStream<T>,
    timeout: Double
) async -> T? {
    await withTaskGroup(of: T?.self) { group in
        group.addTask {
            for await value in stream { return value }
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

/// Hoisted to file scope: Swift disallows non-generic types nested inside generic functions.
private final class SRUpdateCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [SessionUpdate] = []
    func append(_ item: SessionUpdate) { lock.withLock { items.append(item) } }
    var all: [SessionUpdate] { lock.withLock { items } }
}

private func collectFirst(
    n: Int,
    from stream: AsyncStream<SessionUpdate>,
    timeout: Double
) async -> [SessionUpdate] {
    let collector = SRUpdateCollector()

    await withTaskGroup(of: Void.self) { group in
        group.addTask {
            for await value in stream {
                collector.append(value)
                if collector.all.count >= n { break }
            }
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
        }
        await group.next()
        group.cancelAll()
    }
    return collector.all
}
