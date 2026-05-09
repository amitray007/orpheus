import XCTest
import Foundation
@testable import OrpheusCore

final class SessionsIndexRepositoryTests: XCTestCase {

    private var db: Database!
    private var repo: SessionsIndexRepository!

    override func setUp() async throws {
        db = try await Database(inMemory: ())
        repo = SessionsIndexRepository(database: db)
    }

    private func makeEntry(
        name: String = "Session",
        cwd: String = "/tmp/project",
        gitBranch: String? = "main"
    ) -> SessionIndexEntry {
        SessionIndexEntry(
            sessionID: SessionID(),
            cwd: cwd,
            name: name,
            gitBranch: gitBranch
        )
    }

    // MARK: - Upsert

    func testUpsertInsertsNewEntry() async throws {
        let entry = makeEntry(name: "Alpha")
        try await repo.upsert(entry)
        let results = try await repo.search(query: "Alpha")
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results.first?.sessionID, entry.sessionID)
    }

    func testUpsertUpdatesExistingEntry() async throws {
        let entry = makeEntry(name: "OldName")
        try await repo.upsert(entry)

        let updated = SessionIndexEntry(
            sessionID: entry.sessionID,
            cwd: entry.cwd,
            name: "NewName",
            gitBranch: "feature",
            lastUpdated: Date()
        )
        try await repo.upsert(updated)

        let results = try await repo.search(query: "NewName")
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results.first?.name, "NewName")

        // Old name should not match.
        let oldResults = try await repo.search(query: "OldName")
        XCTAssertTrue(oldResults.isEmpty)
    }

    // MARK: - Identity vs cwd separation (N1 regression test)

    func testSessionIDAndCwdAreStoredSeparately() async throws {
        // Use a session ID that is NOT the cwd path.
        let sessionID = SessionID(rawValue: "abc-123-distinct-id")
        let cwd = "/Users/me/code/projects/foo"
        let entry = SessionIndexEntry(
            sessionID: sessionID,
            cwd: cwd,
            name: "MyProject",
            gitBranch: "main"
        )
        try await repo.upsert(entry)

        // Searching by the cwd path should return the entry.
        let byProjectDir = try await repo.search(query: "projects")
        XCTAssertEqual(byProjectDir.count, 1)
        XCTAssertEqual(byProjectDir.first?.sessionID, sessionID)
        XCTAssertEqual(byProjectDir.first?.cwd, cwd)

        // Searching by the unique session ID stem should NOT match
        // (UNINDEXED column is not part of the FTS5 lexicon).
        let bySessionID = try await repo.search(query: "abc")
        XCTAssertTrue(bySessionID.isEmpty)
    }

    func testSearchByCwdSubstring() async throws {
        let cwd = "/Users/me/code/projects/foo"
        let entry = SessionIndexEntry(
            sessionID: SessionID(),
            cwd: cwd,
            name: "Foo",
            gitBranch: "main"
        )
        try await repo.upsert(entry)

        // Match a single word from the path.
        let results = try await repo.search(query: "projects")
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results.first?.cwd, cwd)
    }

    // MARK: - Delete

    func testDeleteRemovesEntry() async throws {
        let entry = makeEntry(name: "DeleteMe")
        try await repo.upsert(entry)
        try await repo.delete(sessionID: entry.sessionID)
        let results = try await repo.search(query: "DeleteMe")
        XCTAssertTrue(results.isEmpty)
    }

    func testDeleteOnlyAffectsTargetedSessionID() async throws {
        let entry1 = makeEntry(name: "KeepThisOne")
        let entry2 = makeEntry(name: "DeleteThisOne")
        try await repo.upsert(entry1)
        try await repo.upsert(entry2)

        try await repo.delete(sessionID: entry2.sessionID)

        let kept = try await repo.search(query: "KeepThisOne")
        XCTAssertEqual(kept.count, 1)
        let removed = try await repo.search(query: "DeleteThisOne")
        XCTAssertTrue(removed.isEmpty)
    }

    func testDeleteNonexistentIsNoop() async throws {
        // Must not throw.
        try await repo.delete(sessionID: SessionID())
    }

    // MARK: - Search

    func testSearchReturnsMatchingEntries() async throws {
        // Names should be tokenizable words (or word-prefixes).
        try await repo.upsert(makeEntry(name: "Rustlang"))
        try await repo.upsert(makeEntry(name: "Swiftlang"))
        try await repo.upsert(makeEntry(name: "Golang"))

        let results = try await repo.search(query: "Swift")
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results.first?.name, "Swiftlang")
    }

    func testSearchEmptyQueryReturnsEmpty() async throws {
        try await repo.upsert(makeEntry(name: "Something"))
        let results = try await repo.search(query: "")
        XCTAssertTrue(results.isEmpty)
    }

    func testSearchWithLimitRespected() async throws {
        for i in 0..<10 {
            try await repo.upsert(makeEntry(name: "Project\(i)"))
        }
        let results = try await repo.search(query: "Project", limit: 3)
        XCTAssertLessThanOrEqual(results.count, 3)
    }

    func testSearchAcrossGitBranch() async throws {
        // FTS5 tokenizes hyphens as word boundaries; search by full branch name
        // using the repository's phrase-prefix wrapping which handles hyphens.
        let entry = makeEntry(name: "Session", gitBranch: "feature-login")
        try await repo.upsert(entry)
        let results = try await repo.search(query: "feature-login")
        XCTAssertEqual(results.count, 1)
    }

    // MARK: - Roundtrip preserves all fields

    func testFullRoundTripPreservesAllFields() async throws {
        let now = Date()
        let entry = SessionIndexEntry(
            sessionID: SessionID(rawValue: "round-trip-id"),
            cwd: "/tmp/round-trip-project",
            name: "RoundTrip",
            gitBranch: "main",
            lastUpdated: now
        )
        try await repo.upsert(entry)
        let results = try await repo.search(query: "RoundTrip")
        XCTAssertEqual(results.count, 1)
        let fetched = results.first
        XCTAssertEqual(fetched?.sessionID, entry.sessionID)
        XCTAssertEqual(fetched?.cwd, entry.cwd)
        XCTAssertEqual(fetched?.name, entry.name)
        XCTAssertEqual(fetched?.gitBranch, entry.gitBranch)
        // Timestamp round-trips with Double precision (sub-millisecond).
        let elapsed = abs((fetched?.lastUpdated.timeIntervalSinceReferenceDate ?? 0)
                           - now.timeIntervalSinceReferenceDate)
        XCTAssertLessThan(elapsed, 0.001)
    }
}
