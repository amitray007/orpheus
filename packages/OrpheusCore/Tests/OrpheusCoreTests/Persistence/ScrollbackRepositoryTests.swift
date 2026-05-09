import XCTest
import Foundation
@testable import OrpheusCore

final class ScrollbackRepositoryTests: XCTestCase {

    private var db: Database!
    private var termRepo: TerminalRepository!
    private var repo: ScrollbackRepository!
    private var termID: TerminalID!

    override func setUp() async throws {
        db = try await Database(inMemory: ())
        termRepo = TerminalRepository(database: db)
        repo = ScrollbackRepository(database: db)

        // Scaffold the required parent hierarchy.
        let projRepo = ProjectRepository(database: db)
        let spaceRepo = SpaceRepository(database: db)

        let project = Project(name: "P", rootPath: "/tmp")
        try await projRepo.create(project)
        let space = Space(projectID: project.id, name: "S", layoutSpec: .canvas([]), ord: 0)
        try await spaceRepo.create(space)
        let terminal = Terminal(spaceID: space.id, cwd: "/tmp")
        try await termRepo.create(terminal)
        termID = terminal.id
    }

    // MARK: - Basic append + flush + read

    func testAppendAndReadChunks() async throws {
        let data = Data("hello world".utf8)
        await repo.append(terminalID: termID, bytes: data)
        try await repo.flush(terminalID: termID)

        let chunks = try await repo.chunks(terminalID: termID)
        XCTAssertEqual(chunks.count, 1)
        XCTAssertEqual(chunks[0], data)
    }

    func testFlushAllTerminalsNil() async throws {
        let data = Data("abc".utf8)
        await repo.append(terminalID: termID, bytes: data)
        try await repo.flush()
        let chunks = try await repo.chunks(terminalID: termID)
        XCTAssertEqual(chunks.count, 1)
    }

    func testChunksOrderedByChunkIndex() async throws {
        // Write three separate chunks by flushing after each.
        let a = Data("AAA".utf8)
        let b = Data("BBB".utf8)
        let c = Data("CCC".utf8)

        await repo.append(terminalID: termID, bytes: a)
        try await repo.flush(terminalID: termID)

        await repo.append(terminalID: termID, bytes: b)
        try await repo.flush(terminalID: termID)

        await repo.append(terminalID: termID, bytes: c)
        try await repo.flush(terminalID: termID)

        let chunks = try await repo.chunks(terminalID: termID)
        XCTAssertEqual(chunks.count, 3)
        XCTAssertEqual(chunks[0], a)
        XCTAssertEqual(chunks[1], b)
        XCTAssertEqual(chunks[2], c)
    }

    func testEmptyFlushProducesNoChunks() async throws {
        try await repo.flush(terminalID: termID)
        let chunks = try await repo.chunks(terminalID: termID)
        XCTAssertTrue(chunks.isEmpty)
    }

    // MARK: - Chunk-size threshold

    func testBufferOverChunkSizeFlushesImmediately() async throws {
        // Fill buffer to just over the chunk-size limit.
        let bigData = Data(repeating: 0xAB, count: ScrollbackConstants.scrollbackChunkSize + 1)
        await repo.append(terminalID: termID, bytes: bigData)
        // No explicit flush needed — the overflow should trigger an automatic flush.
        // Give any background work a moment to complete.
        try await Task.sleep(nanoseconds: 50_000_000)  // 50 ms
        let chunks = try await repo.chunks(terminalID: termID)
        // At least one chunk should have landed.
        XCTAssertFalse(chunks.isEmpty)
    }

    // MARK: - Ring-buffer eviction

    func testRingBufferEvictsOldestChunks() async throws {
        let limit = ScrollbackConstants.scrollbackRingLimit
        // Write limit + 2 chunks.
        for i in 0..<(limit + 2) {
            let data = Data("chunk \(i)".utf8)
            await repo.append(terminalID: termID, bytes: data)
            try await repo.flush(terminalID: termID)
        }

        let chunks = try await repo.chunks(terminalID: termID)
        // Count must not exceed the ring limit.
        XCTAssertLessThanOrEqual(chunks.count, limit)
        // The oldest chunk (index 0) must have been evicted.
        XCTAssertFalse(chunks.contains(Data("chunk 0".utf8)))
    }

    // MARK: - Multiple terminals

    func testChunksIsolatedPerTerminal() async throws {
        // Create a second terminal.
        let projRepo = ProjectRepository(database: db)
        let spaceRepo = SpaceRepository(database: db)
        let project = Project(name: "P2", rootPath: "/tmp2")
        try await projRepo.create(project)
        let space = Space(projectID: project.id, name: "S2", layoutSpec: .canvas([]), ord: 0)
        try await spaceRepo.create(space)
        let term2 = Terminal(spaceID: space.id, cwd: "/tmp2")
        try await termRepo.create(term2)

        await repo.append(terminalID: termID, bytes: Data("for-t1".utf8))
        await repo.append(terminalID: term2.id, bytes: Data("for-t2".utf8))
        try await repo.flush()

        let chunks1 = try await repo.chunks(terminalID: termID)
        let chunks2 = try await repo.chunks(terminalID: term2.id)
        XCTAssertEqual(chunks1.first, Data("for-t1".utf8))
        XCTAssertEqual(chunks2.first, Data("for-t2".utf8))
    }
}
