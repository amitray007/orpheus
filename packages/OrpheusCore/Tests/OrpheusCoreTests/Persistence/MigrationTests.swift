import XCTest
import Foundation
import GRDB
@testable import OrpheusCore

/// Tests every migration individually: prior state → apply → assert.
final class MigrationTests: XCTestCase {

    // MARK: - Helpers

    /// Open a bare in-memory DatabaseQueue and apply only migrations up to
    /// (but not including) the one under test.  Returns the queue.
    // Helper kept for potential future per-migration isolation tests.
    // Not currently called; individual tests use makeMigrator().migrate(q, upTo:) directly.

    // MARK: - Individual migration tests

    func testCreateProjects() throws {
        let q = try DatabaseQueue(configuration: makeConfig())
        let migrator = Migrations.makeMigrator()
        try migrator.migrate(q, upTo: "2026-05-10-create-projects")

        try q.inDatabase { db in
            // Table exists and we can insert/read back.
            try db.execute(
                sql: """
                    INSERT INTO projects (id, name, root_path, lifecycle_state, tags, created_at, updated_at)
                    VALUES ('p1', 'Proj', '/tmp', 'active', '[]', 0.0, 0.0)
                    """
            )
            let name = try String.fetchOne(db, sql: "SELECT name FROM projects WHERE id = 'p1'")
            XCTAssertEqual(name, "Proj")
        }
    }

    func testCreateSpaces() throws {
        let q = try DatabaseQueue(configuration: makeConfig())
        let migrator = Migrations.makeMigrator()
        try migrator.migrate(q, upTo: "2026-05-10-create-spaces")

        try q.inDatabase { db in
            // Insert prerequisite project first.
            try db.execute(
                sql: """
                    INSERT INTO projects (id, name, root_path, lifecycle_state, tags, created_at, updated_at)
                    VALUES ('p1', 'P', '/tmp', 'active', '[]', 0.0, 0.0)
                    """
            )
            try db.execute(
                sql: """
                    INSERT INTO spaces
                    (id, project_id, name, layout_spec, ord, lifecycle_state, created_at, updated_at)
                    VALUES ('s1', 'p1', 'Space', '{}', 0, 'active', 0.0, 0.0)
                    """
            )
            let count = try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM spaces") ?? 0
            XCTAssertEqual(count, 1)
        }
    }

    func testCreateTerminals() throws {
        let q = try DatabaseQueue(configuration: makeConfig())
        let migrator = Migrations.makeMigrator()
        try migrator.migrate(q, upTo: "2026-05-10-create-terminals")

        try q.inDatabase { db in
            try db.execute(
                sql: """
                    INSERT INTO projects (id, name, root_path, lifecycle_state, tags, created_at, updated_at)
                    VALUES ('p1', 'P', '/tmp', 'active', '[]', 0.0, 0.0)
                    """
            )
            try db.execute(
                sql: """
                    INSERT INTO spaces
                    (id, project_id, name, layout_spec, ord, lifecycle_state, created_at, updated_at)
                    VALUES ('s1', 'p1', 'Space', '{}', 0, 'active', 0.0, 0.0)
                    """
            )
            try db.execute(
                sql: """
                    INSERT INTO terminals (id, space_id, cwd, status, created_at)
                    VALUES ('t1', 's1', '/tmp', 'stopped', 0.0)
                    """
            )
            let count = try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM terminals") ?? 0
            XCTAssertEqual(count, 1)
        }
    }

    func testCreateTerminalScrollback() throws {
        let q = try DatabaseQueue(configuration: makeConfig())
        let migrator = Migrations.makeMigrator()
        try migrator.migrate(q, upTo: "2026-05-10-create-terminal-scrollback")

        try q.inDatabase { db in
            try db.execute(
                sql: """
                    INSERT INTO projects (id, name, root_path, lifecycle_state, tags, created_at, updated_at)
                    VALUES ('p1', 'P', '/tmp', 'active', '[]', 0.0, 0.0)
                    """
            )
            try db.execute(
                sql: """
                    INSERT INTO spaces
                    (id, project_id, name, layout_spec, ord, lifecycle_state, created_at, updated_at)
                    VALUES ('s1', 'p1', 'Space', '{}', 0, 'active', 0.0, 0.0)
                    """
            )
            try db.execute(
                sql: """
                    INSERT INTO terminals (id, space_id, cwd, status, created_at)
                    VALUES ('t1', 's1', '/tmp', 'stopped', 0.0)
                    """
            )
            let blob = "hello".data(using: .utf8)!
            try db.execute(
                sql: "INSERT INTO terminal_scrollback (terminal_id, chunk_index, bytes) VALUES ('t1', 0, ?)",
                arguments: [blob]
            )
            let count = try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM terminal_scrollback") ?? 0
            XCTAssertEqual(count, 1)
        }
    }

    func testCreateSessionsIndex() throws {
        let q = try DatabaseQueue(configuration: makeConfig())
        let migrator = Migrations.makeMigrator()
        try migrator.migrate(q, upTo: "2026-05-10-create-sessions-index")

        try q.inDatabase { db in
            try db.execute(
                sql: """
                    INSERT INTO sessions_index (cwd, name, git_branch, last_updated)
                    VALUES ('session-1', 'My Session', 'main', '2026-05-10T00:00:00Z')
                    """
            )
            let count = try Int.fetchOne(
                db, sql: "SELECT COUNT(*) FROM sessions_index"
            ) ?? 0
            XCTAssertEqual(count, 1)
        }
    }

    func testCreateAppState() throws {
        let q = try DatabaseQueue(configuration: makeConfig())
        let migrator = Migrations.makeMigrator()
        try migrator.migrate(q)

        try q.inDatabase { db in
            try db.execute(
                sql: "INSERT INTO app_state (key, value) VALUES ('windowFrame', '{}')"
            )
            let val = try String.fetchOne(
                db, sql: "SELECT value FROM app_state WHERE key = 'windowFrame'"
            )
            XCTAssertEqual(val, "{}")
        }
    }

    // MARK: - Idempotency

    func testRunningMigratorTwiceIsNoop() throws {
        let q = try DatabaseQueue(configuration: makeConfig())
        let migrator = Migrations.makeMigrator()
        // First application
        try migrator.migrate(q)
        // Second application — must not throw
        XCTAssertNoThrow(try migrator.migrate(q))
    }

    // MARK: - Cascade survival

    func testExistingRowsSurviveSubsequentMigrations() throws {
        let q = try DatabaseQueue(configuration: makeConfig())
        let migrator = Migrations.makeMigrator()
        try migrator.migrate(q, upTo: "2026-05-10-create-projects")

        try q.inDatabase { db in
            try db.execute(
                sql: """
                    INSERT INTO projects (id, name, root_path, lifecycle_state, tags, created_at, updated_at)
                    VALUES ('survive-me', 'Survivor', '/tmp', 'active', '[]', 0.0, 0.0)
                    """
            )
        }

        // Apply remaining migrations.
        try migrator.migrate(q)

        // Row still present after full migration run.
        try q.inDatabase { db in
            let name = try String.fetchOne(
                db, sql: "SELECT name FROM projects WHERE id = 'survive-me'"
            )
            XCTAssertEqual(name, "Survivor")
        }
    }

    // MARK: - Helpers

    private func makeConfig() -> Configuration {
        var c = Configuration()
        c.foreignKeysEnabled = true
        return c
    }
}
