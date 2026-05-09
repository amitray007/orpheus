import XCTest
import Foundation
import GRDB
@testable import OrpheusCore

final class DatabaseTests: XCTestCase {

    // MARK: - In-memory open/close

    func testInMemoryOpenSucceeds() async throws {
        let db = try await Database(inMemory: ())
        // Smoke-read: if migrations ran the table exists
        let count = try await db.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM projects") ?? 0
        }
        XCTAssertEqual(count, 0)
    }

    func testFileBackedOpenCreatesFile() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("orpheus-db-test-\(UUID().uuidString).sqlite")
        defer { try? FileManager.default.removeItem(at: url) }

        let db = try await Database(path: url.path)
        let count = try await db.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM projects") ?? 0
        }
        XCTAssertEqual(count, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    }

    // MARK: - Close + reopen round-trip

    func testCloseAndReopenRetainsData() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("orpheus-db-reopen-\(UUID().uuidString).sqlite")
        defer { try? FileManager.default.removeItem(at: url) }

        // Open, insert a project, close (deinit).
        let projectID = ProjectID()
        do {
            let db = try await Database(path: url.path)
            try await db.write { db in
                try db.execute(
                    sql: """
                        INSERT INTO projects (id, name, root_path, lifecycle_state, tags, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                    arguments: [
                        projectID.rawValue, "Test", "/tmp", "active", "[]",
                        Date().timeIntervalSinceReferenceDate,
                        Date().timeIntervalSinceReferenceDate,
                    ]
                )
            }
            // db deinits here
        }

        // Re-open and verify row survived.
        let db2 = try await Database(path: url.path)
        let name: String? = try await db2.read { db in
            let row = try Row.fetchOne(
                db,
                sql: "SELECT name FROM projects WHERE id = ?",
                arguments: [projectID.rawValue]
            )
            return row?["name"]
        }
        XCTAssertEqual(name, "Test")
    }

    // MARK: - Foreign keys enforcement

    func testForeignKeyViolationThrows() async throws {
        let db = try await Database(inMemory: ())
        await XCTAssertThrowsErrorAsync {
            try await db.write { db in
                // Insert a space without a matching project — should fail FK.
                try db.execute(
                    sql: """
                        INSERT INTO spaces
                        (id, project_id, name, layout_spec, ord, lifecycle_state, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                    arguments: [
                        SpaceID().rawValue, ProjectID().rawValue,
                        "Orphan", "{}", 0, "active",
                        Date().timeIntervalSinceReferenceDate,
                        Date().timeIntervalSinceReferenceDate,
                    ]
                )
            }
        }
    }
}

// MARK: - Async test helper

func XCTAssertThrowsErrorAsync(
    _ expression: () async throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        try await expression()
        XCTFail("Expected error but none was thrown", file: file, line: line)
    } catch {
        // pass
    }
}
