import Foundation

/// Thin glue between `SessionRegistry` and `SessionsIndexRepository`.
///
/// Converts `SessionMetadata` → `SessionIndexEntry` and delegates all FTS5
/// reads/writes to the repository.  The indexer is OPTIONAL on
/// `SessionRegistry`; when nil, the registry maintains only the in-memory
/// index and skips FTS5 writes.
///
/// Idempotent: `index(_:)` calls the repository's `upsert`, which performs
/// DELETE + INSERT, so re-indexing the same session is a no-op.
public actor SessionsIndexer {

    private let repository: SessionsIndexRepository

    public init(repository: SessionsIndexRepository) {
        self.repository = repository
    }

    // MARK: - Public interface

    /// Upsert `metadata` into the FTS5 index.
    public func index(_ metadata: SessionMetadata) async throws {
        let entry = SessionIndexEntry(
            sessionID: metadata.sessionID,
            cwd: metadata.cwd,
            name: metadata.name,
            gitBranch: metadata.gitBranch,
            lastUpdated: metadata.lastUpdated
        )
        try await repository.upsert(entry)
    }

    /// Remove the FTS5 row for `sessionID`.
    public func remove(_ sessionID: SessionID) async throws {
        try await repository.delete(sessionID: sessionID)
    }

    /// Full-text search.  Delegates directly to the repository.
    public func search(query: String, limit: Int = 50) async throws -> [SessionIndexEntry] {
        try await repository.search(query: query, limit: limit)
    }
}
