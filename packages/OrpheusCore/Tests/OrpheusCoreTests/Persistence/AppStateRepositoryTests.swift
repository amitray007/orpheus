import XCTest
import Foundation
@testable import OrpheusCore

final class AppStateRepositoryTests: XCTestCase {

    private var db: Database!
    private var repo: AppStateRepository!

    override func setUp() async throws {
        db = try await Database(inMemory: ())
        repo = AppStateRepository(database: db)
    }

    // MARK: - get / set

    func testSetAndGet() async throws {
        try await repo.set(key: "windowFrame", value: "{\"x\":0}")
        let value = try await repo.get(key: "windowFrame")
        XCTAssertEqual(value, "{\"x\":0}")
    }

    func testGetMissingKeyReturnsNil() async throws {
        let value = try await repo.get(key: "nonexistent")
        XCTAssertNil(value)
    }

    func testSetOverwritesExistingValue() async throws {
        try await repo.set(key: "theme", value: "\"dark\"")
        try await repo.set(key: "theme", value: "\"light\"")
        let value = try await repo.get(key: "theme")
        XCTAssertEqual(value, "\"light\"")
    }

    // MARK: - delete

    func testDeleteRemovesEntry() async throws {
        try await repo.set(key: "deletable", value: "true")
        try await repo.delete(key: "deletable")
        let value = try await repo.get(key: "deletable")
        XCTAssertNil(value)
    }

    func testDeleteNonexistentIsNoop() async throws {
        // Must not throw.
        try await repo.delete(key: "phantom")
    }

    // MARK: - Multiple keys

    func testMultipleKeys() async throws {
        try await repo.set(key: "a", value: "\"A\"")
        try await repo.set(key: "b", value: "\"B\"")
        try await repo.set(key: "c", value: "\"C\"")

        let a = try await repo.get(key: "a")
        let b = try await repo.get(key: "b")
        let c = try await repo.get(key: "c")
        XCTAssertEqual(a, "\"A\"")
        XCTAssertEqual(b, "\"B\"")
        XCTAssertEqual(c, "\"C\"")
    }

    // MARK: - JSON value round-trips

    func testComplexJSONValueRoundTrips() async throws {
        let json = "[1,2,3,\"hello\",true,null]"
        try await repo.set(key: "complex", value: json)
        let fetched = try await repo.get(key: "complex")
        XCTAssertEqual(fetched, json)
    }

    func testEmptyStringValue() async throws {
        try await repo.set(key: "empty", value: "\"\"")
        let fetched = try await repo.get(key: "empty")
        XCTAssertEqual(fetched, "\"\"")
    }
}
