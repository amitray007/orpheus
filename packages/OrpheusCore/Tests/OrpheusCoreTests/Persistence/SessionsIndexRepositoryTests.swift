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
        cwd: String? = nil,
        gitBranch: String? = "main"
    ) -> SessionIndexEntry {
        let id = SessionID()
        return SessionIndexEntry(
            sessionID: id,
            cwd: cwd ?? id.rawValue,
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
        let entry = makeEntry(name: "Old Name")
        try await repo.upsert(entry)

        let updated = SessionIndexEntry(
            sessionID: entry.sessionID,
            cwd: entry.cwd,
            name: "New Name",
            gitBranch: "feature",
            lastUpdated: Date()
        )
        try await repo.upsert(updated)

        let results = try await repo.search(query: "New")
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results.first?.name, "New Name")

        // Old name should not match.
        let oldResults = try await repo.search(query: "Old")
        XCTAssertTrue(oldResults.isEmpty)
    }

    // MARK: - Delete

    func testDeleteRemovesEntry() async throws {
        let entry = makeEntry(name: "Delete Me")
        try await repo.upsert(entry)
        try await repo.delete(sessionID: entry.sessionID)
        let results = try await repo.search(query: "Delete")
        XCTAssertTrue(results.isEmpty)
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
            try await repo.upsert(makeEntry(name: "Project \(i)"))
        }
        let results = try await repo.search(query: "Project", limit: 3)
        XCTAssertLessThanOrEqual(results.count, 3)
    }

    func testSearchAcrossGitBranch() async throws {
        // FTS5 tokenizes hyphens as word boundaries; search by full branch name
        // using the repository's phrase-prefix wrapping which handles hyphens.
        let entry = makeEntry(name: "Session", gitBranch: "feature-login")
        try await repo.upsert(entry)
        // Search for the branch prefix — the phrase query wraps it safely.
        let results = try await repo.search(query: "feature-login")
        XCTAssertEqual(results.count, 1)
    }
}
