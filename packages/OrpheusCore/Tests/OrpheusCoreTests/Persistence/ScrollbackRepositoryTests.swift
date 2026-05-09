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
        // The overflow path inside append() awaits the flush synchronously, so
        // by the time append returns the chunk has already landed in SQLite.
        await repo.append(terminalID: termID, bytes: bigData)
        let chunks = try await repo.chunks(terminalID: termID)
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

    // MARK: - Error propagation

    /// When the parent terminal row no longer exists, the FK constraint on
    /// `terminal_scrollback.terminal_id` causes the write to fail.  The
    /// synchronous `flush()` path must propagate this error.
    func testFlushPropagatesWriteError() async throws {
        // Append before deleting so there is buffered data to flush.
        await repo.append(terminalID: termID, bytes: Data("hello".utf8))
        // Delete the parent terminal (cascades to scrollback, but the
        // pending in-memory buffer remains — the FK violation will fire
        // when the deferred write tries to insert).
        try await termRepo.delete(id: termID)

        await XCTAssertThrowsErrorAsync {
            try await self.repo.flush(terminalID: self.termID)
        }
    }

    /// A flush that completes successfully clears any previously stored
    /// deferred-flush error.  Following pattern: cause an error, surface it,
    /// then verify the next flush is clean.
    func testStoredErrorIsClearedOnNextFlush() async throws {
        // Cause an error: append, delete parent, attempt flush — throws.
        await repo.append(terminalID: termID, bytes: Data("first".utf8))
        try await termRepo.delete(id: termID)
        await XCTAssertThrowsErrorAsync {
            try await self.repo.flush(terminalID: self.termID)
        }

        // A subsequent flush against an unrelated, valid terminal should now
        // succeed (lastFlushError, if any, was cleared by the previous throw).
        let projRepo = ProjectRepository(database: db)
        let spaceRepo = SpaceRepository(database: db)
        let p = Project(name: "P3", rootPath: "/tmp3")
        try await projRepo.create(p)
        let s = Space(projectID: p.id, name: "S3", layoutSpec: .canvas([]), ord: 0)
        try await spaceRepo.create(s)
        let term3 = Terminal(spaceID: s.id, cwd: "/tmp3")
        try await termRepo.create(term3)

        await repo.append(terminalID: term3.id, bytes: Data("ok".utf8))
        // Must not throw.
        try await repo.flush(terminalID: term3.id)
        let chunks = try await repo.chunks(terminalID: term3.id)
        XCTAssertEqual(chunks.first, Data("ok".utf8))
    }
}
