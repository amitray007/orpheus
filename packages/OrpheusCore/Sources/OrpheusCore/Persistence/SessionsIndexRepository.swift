import Foundation
import GRDB

/// Read/write interface for the `sessions_index` FTS5 virtual table.
///
/// This repository is called exclusively by Group 5 (Sessions), which parses
/// JSONL metadata and hands `SessionIndexEntry` values here for indexing.
///
/// The FTS5 table has a dedicated `session_id` UNINDEXED column for identity,
/// distinct from the searchable `cwd` column.  Upsert is implemented as
/// DELETE + INSERT keyed on `session_id` because FTS5 does not support
/// `ON CONFLICT`.
public actor SessionsIndexRepository {

    private let database: Database

    public init(database: Database) {
        self.database = database
    }

    // MARK: - Public interface

    /// Insert or replace an entry for the given session.
    ///
    /// Implementation: DELETE existing row(s) for `entry.sessionID`, then INSERT.
    /// All five columns are populated; `nil` `name` and `gitBranch` are stored
    /// as empty strings so FTS5 has well-formed text to tokenise.
    public func upsert(_ entry: SessionIndexEntry) async throws {
        try await database.write { db in
            try db.execute(
                sql: "DELETE FROM sessions_index WHERE session_id = ?",
                arguments: [entry.sessionID.rawValue]
            )
            try db.execute(
                sql: """
                    INSERT INTO sessions_index
                    (session_id, cwd, name, git_branch, last_updated)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                arguments: [
                    entry.sessionID.rawValue,
                    entry.cwd,
                    entry.name ?? "",
                    entry.gitBranch ?? "",
                    entry.lastUpdated.timeIntervalSinceReferenceDate,
                ]
            )
        }
    }

    /// Remove the FTS5 row whose `session_id` equals the given session ID.
    public func delete(sessionID: SessionID) async throws {
        try await database.write { db in
            try db.execute(
                sql: "DELETE FROM sessions_index WHERE session_id = ?",
                arguments: [sessionID.rawValue]
            )
        }
    }

    /// Full-text search across `cwd`, `name`, and `git_branch`.
    /// Returns matching `SessionIndexEntry` values ordered by FTS5 rank.
    ///
    /// The query is wrapped in double quotes to form a phrase expression, then
    /// a `*` suffix is appended for prefix matching.  This means the literal
    /// search string is matched as a phrase prefix, which handles spaces and
    /// hyphens safely.
    public func search(query: String, limit: Int = 20) async throws -> [SessionIndexEntry] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        // Build a safe FTS5 query: escape double-quotes inside the term,
        // then wrap in double-quotes for a phrase search with a prefix wildcard.
        let escaped = trimmed.replacingOccurrences(of: "\"", with: "\"\"")
        let ftsQuery = "\"\(escaped)\"*"
        return try await database.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: """
                    SELECT session_id, cwd, name, git_branch, last_updated
                    FROM sessions_index
                    WHERE sessions_index MATCH ?
                    ORDER BY rank
                    LIMIT ?
                    """,
                arguments: [ftsQuery, limit]
            )
            return rows.compactMap { row -> SessionIndexEntry? in
                guard
                    let sessionIDStr = row["session_id"] as? String,
                    let cwd = row["cwd"] as? String
                else { return nil }
                let name = row["name"] as? String
                let gitBranch = row["git_branch"] as? String
                // last_updated stored as REAL (timeIntervalSinceReferenceDate).
                let lastUpdatedValue: DatabaseValue = row["last_updated"]
                let interval = Double.fromDatabaseValue(lastUpdatedValue) ?? 0
                let lastUpdated = Date(timeIntervalSinceReferenceDate: interval)
                return SessionIndexEntry(
                    sessionID: SessionID(rawValue: sessionIDStr),
                    cwd: cwd,
                    name: (name?.isEmpty ?? true) ? nil : name,
                    gitBranch: (gitBranch?.isEmpty ?? true) ? nil : gitBranch,
                    lastUpdated: lastUpdated
                )
            }
        }
    }
}
