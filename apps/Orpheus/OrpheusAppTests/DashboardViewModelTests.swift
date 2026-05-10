import XCTest
@testable import Orpheus
import OrpheusCore

@MainActor
final class DashboardViewModelTests: XCTestCase {

    // MARK: - Test scratch directory

    private var tmpDir: URL!

    override func setUp() async throws {
        tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("DashboardViewModelTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // MARK: - Helpers

    private func makeDB() async throws -> OrpheusCore.Database {
        try await OrpheusCore.Database(inMemory: ())
    }

    /// Write a minimal JSONL session file at `tmpDir/<projectDir>/<sessionId>.jsonl`
    /// with the given `lastUpdated` ISO 8601 timestamp.
    @discardableResult
    private func writeSession(
        projectDir: String,
        sessionId: String,
        cwd: String,
        lastUpdated: String
    ) throws -> URL {
        let dir = tmpDir.appendingPathComponent(projectDir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("\(sessionId).jsonl")

        let header: [String: Any] = ["sessionId": sessionId, "cwd": cwd]
        let last: [String: Any] = ["lastUpdated": lastUpdated, "type": "assistant"]
        let headerLine = String(
            data: try JSONSerialization.data(withJSONObject: header),
            encoding: .utf8
        )!
        let lastLine = String(
            data: try JSONSerialization.data(withJSONObject: last),
            encoding: .utf8
        )!
        let content = headerLine + "\n" + lastLine + "\n"
        try content.data(using: .utf8)!.write(to: file, options: .atomic)
        return file
    }

    // MARK: - Tests

    /// `isLoading` flips to false on first emission from project repository.
    func testIsLoadingFlipsOnFirstEmission() async throws {
        let db = try await makeDB()
        let vm = DashboardViewModel(
            projectRepository: ProjectRepository(database: db),
            sessionRegistry: SessionRegistry(
                rootURL: FileManager.default.homeDirectoryForCurrentUser
            )
        )
        XCTAssertTrue(vm.isLoading, "Should start in loading state")
        vm.start()

        // Give observation time to emit the initial (empty) snapshot
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertFalse(vm.isLoading, "Should not be loading after first emission")
    }

    /// `projects` reflects what's in the repository.
    func testProjectsReflectsRepository() async throws {
        let db = try await makeDB()
        let repo = ProjectRepository(database: db)
        let project = Project(name: "myproj", rootPath: "/tmp/myproj")
        try await repo.create(project)

        let vm = DashboardViewModel(
            projectRepository: repo,
            sessionRegistry: SessionRegistry(
                rootURL: FileManager.default.homeDirectoryForCurrentUser
            )
        )
        vm.start()
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(vm.projects.count, 1)
        XCTAssertEqual(vm.projects.first?.name, "myproj")
    }

    /// `recentSessions` is sorted by `lastUpdated` descending.
    /// Pre-seed three JSONL files with different timestamps, point a
    /// `SessionRegistry` at the directory, start a `DashboardViewModel`, and
    /// assert the resulting order.
    func testRecentSessionsSortedByLastUpdatedDescending() async throws {
        try writeSession(
            projectDir: "proj",
            sessionId: "old",
            cwd: "/work/proj",
            lastUpdated: "2026-01-01T00:00:00.000Z"
        )
        try writeSession(
            projectDir: "proj",
            sessionId: "new",
            cwd: "/work/proj",
            lastUpdated: "2026-03-01T00:00:00.000Z"
        )
        try writeSession(
            projectDir: "proj",
            sessionId: "mid",
            cwd: "/work/proj",
            lastUpdated: "2026-02-01T00:00:00.000Z"
        )

        let db = try await makeDB()
        let registry = SessionRegistry(rootURL: tmpDir)
        let vm = DashboardViewModel(
            projectRepository: ProjectRepository(database: db),
            sessionRegistry: registry
        )

        // Subscribe BEFORE start so we don't miss the initial emissions.
        _ = await registry.updates()
        try await registry.start()

        vm.start()

        // Wait for the initial load + refresh to populate recentSessions.
        try await waitForSessions(in: vm, atLeast: 3, timeout: 2.0)

        XCTAssertEqual(vm.recentSessions.count, 3)
        // Strictly descending by lastUpdated.
        let dates = vm.recentSessions.map(\.lastUpdated)
        XCTAssertGreaterThan(dates[0], dates[1])
        XCTAssertGreaterThan(dates[1], dates[2])
        XCTAssertEqual(vm.recentSessions[0].sessionID.rawValue, "new")
        XCTAssertEqual(vm.recentSessions[1].sessionID.rawValue, "mid")
        XCTAssertEqual(vm.recentSessions[2].sessionID.rawValue, "old")

        await registry.stop()
    }

    /// `recentSessions` refreshes when `SessionRegistry.updates()` emits.
    /// Start with an empty registry, await the empty emission, then write a
    /// new JSONL file to the watched directory; the watcher should fire and
    /// the view model should re-pull the registry, surfacing the new session.
    func testRecentSessionsRefreshOnSessionRegistryUpdate() async throws {
        let db = try await makeDB()
        let registry = SessionRegistry(rootURL: tmpDir)
        let vm = DashboardViewModel(
            projectRepository: ProjectRepository(database: db),
            sessionRegistry: registry
        )

        _ = await registry.updates()
        try await registry.start()
        vm.start()

        // Wait for initial empty load to settle.
        try await Task.sleep(nanoseconds: 250_000_000)
        XCTAssertEqual(vm.recentSessions.count, 0)

        // Write a new session file — this triggers the JSONLWatcher.
        try writeSession(
            projectDir: "proj",
            sessionId: "new-session",
            cwd: "/work/proj",
            lastUpdated: "2026-04-01T00:00:00.000Z"
        )

        // Race the view-model state against a timeout (withTaskGroup pattern).
        let appeared = await waitForSessionAppearance(
            in: vm,
            sessionID: "new-session",
            timeout: 3.0
        )

        XCTAssertTrue(appeared, "Expected new session to appear via SessionRegistry update event")
        XCTAssertEqual(vm.recentSessions.first?.sessionID.rawValue, "new-session")

        await registry.stop()
    }

    // MARK: - withTaskGroup race helpers

    /// Race a polling check for `vm.recentSessions.count >= atLeast` against
    /// a timeout using `withTaskGroup`. Throws on timeout.
    private func waitForSessions(
        in vm: DashboardViewModel,
        atLeast: Int,
        timeout: Double
    ) async throws {
        let success = await withTaskGroup(of: Bool.self) { group in
            group.addTask { @MainActor in
                while vm.recentSessions.count < atLeast {
                    try? await Task.sleep(nanoseconds: 50_000_000)
                    if Task.isCancelled { return false }
                }
                return true
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return false
            }
            let result = await group.next() ?? false
            group.cancelAll()
            return result
        }
        if !success {
            throw XCTSkip("Timed out waiting for \(atLeast) sessions in DashboardViewModel")
        }
    }

    /// Race a polling check for a specific session ID showing up against a
    /// timeout. Returns `true` on success, `false` on timeout.
    private func waitForSessionAppearance(
        in vm: DashboardViewModel,
        sessionID: String,
        timeout: Double
    ) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask { @MainActor in
                while !vm.recentSessions.contains(where: { $0.sessionID.rawValue == sessionID }) {
                    try? await Task.sleep(nanoseconds: 50_000_000)
                    if Task.isCancelled { return false }
                }
                return true
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
}
