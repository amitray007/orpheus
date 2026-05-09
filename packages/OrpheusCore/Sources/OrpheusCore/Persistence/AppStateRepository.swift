import Foundation
import GRDB

/// A simple key-value store backed by the `app_state` SQLite table.
///
/// Values are stored as raw JSON strings; callers are responsible for
/// encoding and decoding their own types.  This is intentional — the
/// repository does not impose a schema on the values, keeping the caller
/// in full control of versioning.
public actor AppStateRepository {

    private let database: Database

    public init(database: Database) {
        self.database = database
    }

    // MARK: - Public interface

    /// Return the JSON string stored under `key`, or `nil` if absent.
    public func get(key: String) async throws -> String? {
        try await database.read { db in
            let row = try Row.fetchOne(
                db,
                sql: "SELECT value FROM app_state WHERE key = ?",
                arguments: [key]
            )
            return row?["value"] as? String
        }
    }

    /// Upsert a JSON string value under `key`.
    public func set(key: String, value: String) async throws {
        try await database.write { db in
            try db.execute(
                sql: """
                    INSERT INTO app_state (key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                    """,
                arguments: [key, value]
            )
        }
    }

    /// Delete the entry for `key` (no-op if absent).
    public func delete(key: String) async throws {
        try await database.write { db in
            try db.execute(
                sql: "DELETE FROM app_state WHERE key = ?",
                arguments: [key]
            )
        }
    }
}
