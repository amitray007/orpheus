import XCTest
import Foundation
@testable import OrpheusCore

final class SessionsIndexerTests: XCTestCase {

    private var database: Database!
    private var repository: SessionsIndexRepository!
    private var indexer: SessionsIndexer!

    override func setUp() async throws {
        database = try await Database()
        repository = SessionsIndexRepository(database: database)
        indexer = SessionsIndexer(repository: repository)
    }

    // MARK: - index (upsert)

    func testIndexInsertsEntry() async throws {
        let metadata = SessionMetadata(
            sessionID: SessionID(rawValue: "test-sid-1"),
            cwd: "/work/project",
            gitBranch: "main",
            name: "Test Session",
            lastUpdated: Date(),
            lastMessageKind: "assistant"
        )

        try await indexer.index(metadata)

        let results = try await indexer.search(query: "Test Session", limit: 10)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].sessionID.rawValue, "test-sid-1")
        XCTAssertEqual(results[0].cwd, "/work/project")
        XCTAssertEqual(results[0].gitBranch, "main")
        XCTAssertEqual(results[0].name, "Test Session")
    }

    // MARK: - index is idempotent (upsert)

    func testIndexIsIdempotent() async throws {
        let sid = SessionID(rawValue: "idem-sid")
        var metadata = SessionMetadata(
            sessionID: sid,
            cwd: "/work/idempotent",
            gitBranch: nil,
            name: "First",
            lastUpdated: Date(timeIntervalSince1970: 1_000_000),
            lastMessageKind: nil
        )

        try await indexer.index(metadata)

        // Upsert the same session with updated name.
        metadata = SessionMetadata(
            sessionID: sid,
            cwd: "/work/idempotent",
            gitBranch: "feature",
            name: "Updated",
            lastUpdated: Date(),
            lastMessageKind: "user"
        )
        try await indexer.index(metadata)

        // Should still be exactly one row for this session.
        let results = try await indexer.search(query: "Updated", limit: 10)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].name, "Updated")
        XCTAssertEqual(results[0].gitBranch, "feature")
    }

    // MARK: - remove

    func testRemoveDeletesEntry() async throws {
        let sid = SessionID(rawValue: "remove-me")
        let metadata = SessionMetadata(
            sessionID: sid,
            cwd: "/work/deletable",
            gitBranch: nil,
            name: "To Remove",
            lastUpdated: Date(),
            lastMessageKind: nil
        )

        try await indexer.index(metadata)
        var results = try await indexer.search(query: "To Remove", limit: 10)
        XCTAssertEqual(results.count, 1)

        try await indexer.remove(sid)
        results = try await indexer.search(query: "To Remove", limit: 10)
        XCTAssertEqual(results.count, 0)
    }

    // MARK: - search delegates to repository

    func testSearchFindsMultipleEntries() async throws {
        for i in 1...3 {
            let m = SessionMetadata(
                sessionID: SessionID(rawValue: "sid-\(i)"),
                cwd: "/work/multi-\(i)",
                gitBranch: "main",
                name: "Session \(i)",
                lastUpdated: Date(),
                lastMessageKind: nil
            )
            try await indexer.index(m)
        }

        let results = try await indexer.search(query: "Session", limit: 10)
        XCTAssertEqual(results.count, 3)
    }

    // MARK: - search: empty query returns empty

    func testSearchEmptyQueryReturnsEmpty() async throws {
        let m = SessionMetadata(
            sessionID: SessionID(rawValue: "sid-empty"),
            cwd: "/work/empty-q",
            gitBranch: nil,
            name: "Something",
            lastUpdated: Date(),
            lastMessageKind: nil
        )
        try await indexer.index(m)

        let results = try await indexer.search(query: "   ", limit: 10)
        XCTAssertTrue(results.isEmpty)
    }

    // MARK: - Metadata → SessionIndexEntry conversion

    func testConversionPreservesOptionals() async throws {
        let metadata = SessionMetadata(
            sessionID: SessionID(rawValue: "conv-sid"),
            cwd: "/conv",
            gitBranch: nil,
            name: nil,
            lastUpdated: Date(),
            lastMessageKind: "user"
        )
        try await indexer.index(metadata)

        let results = try await indexer.search(query: "conv", limit: 10)
        XCTAssertEqual(results.count, 1)
        XCTAssertNil(results[0].name)
        XCTAssertNil(results[0].gitBranch)
    }
}
