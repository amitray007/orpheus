import Foundation
import GRDB

/// Read/write interface for the `sessions_index` FTS5 virtual table.
///
/// This repository is called exclusively by Group 5 (Sessions), which parses
/// JSONL metadata and hands `SessionIndexEntry` values here for indexing.
/// The FTS5 table is keyed by `cwd` (which equals the session's `sessionID`
/// in the rowid-less FTS5 scheme); we store the session ID inside the `cwd`
/// column and use a separate lookup for targeted delete/upsert.
///
/// Because FTS5 does not support a user-defined primary key in the same way
/// as a regular table, upsert is implemented as DELETE + INSERT.
public actor SessionsIndexRepository {

    private let database: Database

    public init(database: Database) {
        self.database = database
    }

    // MARK: - Public interface

    /// Insert or replace an entry for the given session.
    public func upsert(_ entry: SessionIndexEntry) async throws {
        try await database.write { db in
            // FTS5 DELETE + INSERT is the canonical upsert pattern.
            try db.execute(
                sql: "DELETE FROM sessions_index WHERE cwd = ?",
                arguments: [entry.sessionID.rawValue]
            )
            let iso8601 = ISO8601DateFormatter().string(from: entry.lastUpdated)
            try db.execute(
                sql: """
                    INSERT INTO sessions_index (cwd, name, git_branch, last_updated)
                    VALUES (?, ?, ?, ?)
                    """,
                arguments: [
                    entry.sessionID.rawValue,
                    entry.name,
                    entry.gitBranch,
                    iso8601,
                ]
            )
        }
    }

    /// Remove all FTS5 rows whose `cwd` equals the given session ID.
    public func delete(sessionID: SessionID) async throws {
        try await database.write { db in
            try db.execute(
                sql: "DELETE FROM sessions_index WHERE cwd = ?",
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
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return [] }
        // Build a safe FTS5 query: escape double-quotes inside the term,
        // then wrap in double-quotes for a phrase search with a prefix wildcard.
        let escaped = trimmed.replacingOccurrences(of: "\"", with: "\"\"")
        let ftsQuery = "\"\(escaped)\"*"
        return try await database.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: """
                    SELECT cwd, name, git_branch, last_updated
                    FROM sessions_index
                    WHERE sessions_index MATCH ?
                    ORDER BY rank
                    LIMIT ?
                    """,
                arguments: [ftsQuery, limit]
            )
            let formatter = ISO8601DateFormatter()
            return rows.compactMap { row -> SessionIndexEntry? in
                guard let sessionIDStr = row["cwd"] as? String else { return nil }
                let lastUpdatedStr = row["last_updated"] as? String ?? ""
                let lastUpdated = formatter.date(from: lastUpdatedStr) ?? Date()
                return SessionIndexEntry(
                    sessionID: SessionID(rawValue: sessionIDStr),
                    cwd: sessionIDStr,
                    name: row["name"],
                    gitBranch: row["git_branch"],
                    lastUpdated: lastUpdated
                )
            }
        }
    }
}
