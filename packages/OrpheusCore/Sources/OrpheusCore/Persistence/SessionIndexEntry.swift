import Foundation

/// A row in the `sessions_index` FTS5 table.
///
/// This is the inter-group contract between Group 3 (persistence) and
/// Group 5 (sessions).  Group 5 constructs these values from JSONL metadata
/// and hands them to `SessionsIndexRepository`.
public struct SessionIndexEntry: Sendable, Hashable {
    public let sessionID: SessionID
    public let cwd: String
    public let name: String?
    public let gitBranch: String?
    public let lastUpdated: Date

    public init(
        sessionID: SessionID,
        cwd: String,
        name: String? = nil,
        gitBranch: String? = nil,
        lastUpdated: Date = Date()
    ) {
        self.sessionID = sessionID
        self.cwd = cwd
        self.name = name
        self.gitBranch = gitBranch
        self.lastUpdated = lastUpdated
    }
}
