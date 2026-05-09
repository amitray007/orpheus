import XCTest
import Foundation
@testable import OrpheusCore

/// Hammers the `Database` actor and repositories from multiple concurrent tasks.
/// Goals:
/// - No Swift concurrency warnings or data races under TSAN.
/// - All write transactions complete; read-back is consistent.
final class ConcurrencyStressTests: XCTestCase {

    // MARK: - Database actor stress

    func testConcurrentWritesAndReads() async throws {
        let db = try await Database(inMemory: ())
        let repo = ProjectRepository(database: db)

        // Spawn N writers and M concurrent readers.
        let writeCount = 20
        let readCount = 10

        try await withThrowingTaskGroup(of: Void.self) { group in
            // Writers
            for i in 0..<writeCount {
                group.addTask {
                    let project = Project(
                        name: "Concurrent-\(i)",
                        rootPath: "/tmp/concurrent/\(i)"
                    )
                    try await repo.create(project)
                }
            }
            // Readers (concurrent with writers)
            for _ in 0..<readCount {
                group.addTask {
                    _ = try await repo.fetchAll()
                }
            }
            try await group.waitForAll()
        }

        let all = try await repo.fetchAll()
        XCTAssertEqual(all.count, writeCount)
    }

    // MARK: - Scrollback actor stress

    func testConcurrentScrollbackAppends() async throws {
        let db = try await Database(inMemory: ())

        // Build the parent hierarchy once.
        let projRepo = ProjectRepository(database: db)
        let spaceRepo = SpaceRepository(database: db)
        let termRepo = TerminalRepository(database: db)

        let project = Project(name: "StressProject", rootPath: "/tmp/stress")
        try await projRepo.create(project)
        let space = Space(projectID: project.id, name: "StressSpace", layoutSpec: .canvas([]), ord: 0)
        try await spaceRepo.create(space)
        let terminal = Terminal(spaceID: space.id, cwd: "/tmp/stress")
        try await termRepo.create(terminal)

        let scrollback = ScrollbackRepository(database: db)
        let appendCount = 50

        await withTaskGroup(of: Void.self) { group in
            for i in 0..<appendCount {
                group.addTask {
                    let data = Data("chunk-\(i)".utf8)
                    await scrollback.append(terminalID: terminal.id, bytes: data)
                }
            }
        }

        // Force-flush whatever is pending.
        try await scrollback.flush(terminalID: terminal.id)

        let chunks = try await scrollback.chunks(terminalID: terminal.id)
        // All chunks landed (or ring-limit applied) — just assert non-empty and within bounds.
        XCTAssertFalse(chunks.isEmpty)
        XCTAssertLessThanOrEqual(chunks.count, ScrollbackConstants.scrollbackRingLimit)
    }

    // MARK: - Mixed repo stress

    func testMixedRepoStress() async throws {
        let db = try await Database(inMemory: ())
        let projRepo = ProjectRepository(database: db)
        let spaceRepo = SpaceRepository(database: db)

        try await withThrowingTaskGroup(of: Void.self) { group in
            for i in 0..<10 {
                group.addTask {
                    let project = Project(name: "MixedProject-\(i)", rootPath: "/tmp/mixed/\(i)")
                    try await projRepo.create(project)
                    let space = Space(
                        projectID: project.id,
                        name: "MixedSpace-\(i)",
                        layoutSpec: .canvas([]),
                        ord: i
                    )
                    try await spaceRepo.create(space)
                    let spaces = try await spaceRepo.fetchByProject(project.id)
                    XCTAssertEqual(spaces.count, 1)
                }
            }
            try await group.waitForAll()
        }

        let allProjects = try await projRepo.fetchAll()
        XCTAssertEqual(allProjects.count, 10)
    }

    // MARK: - Transactional integrity

    func testNoPartialWritesVisible() async throws {
        let db = try await Database(inMemory: ())
        let repo = ProjectRepository(database: db)

        let project = Project(name: "Atomic", rootPath: "/tmp/atomic")
        try await repo.create(project)

        // Concurrent updates + reads — all reads must see a valid row, never partial.
        await withTaskGroup(of: Void.self) { group in
            for i in 0..<20 {
                group.addTask {
                    var p = project
                    p.name = "Version-\(i)"
                    p.updatedAt = Date()
                    try? await repo.update(p)
                }
                group.addTask {
                    let fetched = try? await repo.fetch(id: project.id)
                    // Must be either nil (race with a delete, not possible here)
                    // or a valid Project.
                    if let fetched {
                        XCTAssertFalse(fetched.name.isEmpty)
                    }
                }
            }
        }
    }

    // MARK: - AppState concurrent set/get

    func testConcurrentAppStateSetGet() async throws {
        let db = try await Database(inMemory: ())
        let repo = AppStateRepository(database: db)

        try await withThrowingTaskGroup(of: Void.self) { group in
            for i in 0..<30 {
                group.addTask {
                    try await repo.set(key: "key-\(i)", value: "\"\(i)\"")
                    let val = try await repo.get(key: "key-\(i)")
                    XCTAssertEqual(val, "\"\(i)\"")
                }
            }
            try await group.waitForAll()
        }
    }
}
