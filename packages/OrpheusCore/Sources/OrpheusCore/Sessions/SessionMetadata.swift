import Foundation

/// Parsed metadata for a single Claude Code session JSONL file.
///
/// Populated by `JSONLLineParser` from the header line (line 1) and the
/// last non-empty line of a `.jsonl` file.  Middle lines (chat history)
/// are never read.
public struct SessionMetadata: Sendable, Hashable, Codable {

    /// The session identifier, from `header.sessionId`.
    public let sessionID: SessionID

    /// The working directory of the session, from `header.cwd`.
    public let cwd: String

    /// The git branch active when the session was created, from `header.gitBranch`.
    public let gitBranch: String?

    /// An optional human-readable session name, from `header.name`.
    public let name: String?

    /// When the session was last updated.  Sourced from `last-line.lastUpdated`
    /// (ISO 8601); falls back to the file's modification-time if the field is
    /// absent or unparseable.
    public let lastUpdated: Date

    /// The `type` field of the last message line (e.g. `"assistant"`, `"user"`).
    /// `nil` when the file contains only the header or the last line has no
    /// `type` field.
    public let lastMessageKind: String?

    public init(
        sessionID: SessionID,
        cwd: String,
        gitBranch: String? = nil,
        name: String? = nil,
        lastUpdated: Date,
        lastMessageKind: String? = nil
    ) {
        self.sessionID = sessionID
        self.cwd = cwd
        self.gitBranch = gitBranch
        self.name = name
        self.lastUpdated = lastUpdated
        self.lastMessageKind = lastMessageKind
    }
}
