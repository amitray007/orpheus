import Foundation
import GRDB

/// Stores and retrieves `Terminal` records from SQLite.
///
/// Terminals cascade-delete from their parent Space.
public actor TerminalRepository {

    private let database: Database

    public init(database: Database) {
        self.database = database
    }

    // MARK: - CRUD

    public func fetchAll() async throws -> [Terminal] {
        try await database.read { db in
            let rows = try Row.fetchAll(db, sql: "SELECT * FROM terminals ORDER BY created_at ASC")
            return try rows.map { try Terminal(row: $0) }
        }
    }

    public func fetch(id: TerminalID) async throws -> Terminal? {
        try await database.read { db in
            let row = try Row.fetchOne(
                db,
                sql: "SELECT * FROM terminals WHERE id = ?",
                arguments: [id.rawValue]
            )
            return try row.map { try Terminal(row: $0) }
        }
    }

    /// All terminals belonging to the given space, ordered by creation time.
    public func fetchBySpace(_ spaceID: SpaceID) async throws -> [Terminal] {
        try await database.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: "SELECT * FROM terminals WHERE space_id = ? ORDER BY created_at ASC",
                arguments: [spaceID.rawValue]
            )
            return try rows.map { try Terminal(row: $0) }
        }
    }

    public func create(_ terminal: Terminal) async throws {
        try await database.write { db in
            try db.execute(
                sql: """
                    INSERT INTO terminals
                    (id, space_id, cwd, command, status, cc_session_id, layout_position, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                arguments: [
                    terminal.id.rawValue,
                    terminal.spaceID.rawValue,
                    terminal.cwd,
                    terminal.command,
                    terminal.status.rawValue,
                    terminal.claudeSessionID?.rawValue,
                    try terminal.encodedLayoutPosition(),
                    terminal.createdAt.timeIntervalSinceReferenceDate,
                ]
            )
        }
    }

    public func update(_ terminal: Terminal) async throws {
        let affected = try await database.write { db -> Int in
            try db.execute(
                sql: """
                    UPDATE terminals
                    SET cwd = ?, command = ?, status = ?, cc_session_id = ?, layout_position = ?
                    WHERE id = ?
                    """,
                arguments: [
                    terminal.cwd,
                    terminal.command,
                    terminal.status.rawValue,
                    terminal.claudeSessionID?.rawValue,
                    try terminal.encodedLayoutPosition(),
                    terminal.id.rawValue,
                ]
            )
            return db.changesCount
        }
        if affected == 0 {
            throw OrpheusCoreError.notFound(id: terminal.id.rawValue, kind: "Terminal")
        }
    }

    public func delete(id: TerminalID) async throws {
        try await database.write { db in
            try db.execute(
                sql: "DELETE FROM terminals WHERE id = ?",
                arguments: [id.rawValue]
            )
        }
    }

    // MARK: - Observation

    /// Emits all terminals whenever any terminal row changes.
    public func observeAll() -> AsyncStream<[Terminal]> {
        let dbWriter = database.writer
        return AsyncStream { continuation in
            let observation = ValueObservation.tracking { db -> [Terminal] in
                let rows = try Row.fetchAll(db, sql: "SELECT * FROM terminals ORDER BY created_at ASC")
                return try rows.map { try Terminal(row: $0) }
            }
            let cancellable = observation.start(
                in: dbWriter,
                scheduling: .async(onQueue: .global(qos: .userInitiated)),
                onError: { _ in continuation.finish() },
                onChange: { terminals in continuation.yield(terminals) }
            )
            continuation.onTermination = { _ in cancellable.cancel() }
        }
    }

    /// Emits terminals for a specific space whenever any of their rows change.
    public func observeBySpace(_ spaceID: SpaceID) -> AsyncStream<[Terminal]> {
        let dbWriter = database.writer
        let sid = spaceID.rawValue
        return AsyncStream { continuation in
            let observation = ValueObservation.tracking { db -> [Terminal] in
                let rows = try Row.fetchAll(
                    db,
                    sql: "SELECT * FROM terminals WHERE space_id = ? ORDER BY created_at ASC",
                    arguments: [sid]
                )
                return try rows.map { try Terminal(row: $0) }
            }
            let cancellable = observation.start(
                in: dbWriter,
                scheduling: .async(onQueue: .global(qos: .userInitiated)),
                onError: { _ in continuation.finish() },
                onChange: { terminals in continuation.yield(terminals) }
            )
            continuation.onTermination = { _ in cancellable.cancel() }
        }
    }
}

// MARK: - Row decoding (module-internal)

private extension Terminal {
    init(row: Row) throws {
        guard
            let idStr = row["id"] as? String,
            let spaceIDStr = row["space_id"] as? String,
            let cwd = row["cwd"] as? String,
            let statusRaw = row["status"] as? String,
            let status = TerminalStatus(rawValue: statusRaw),
            let createdAtInterval = row["created_at"] as? Double
        else {
            throw OrpheusCoreError.persistenceFailed(reason: "Corrupt terminal row")
        }
        let command: String? = row["command"]
        let ccSessionIDStr: String? = row["cc_session_id"]
        let layoutPositionJSON: String? = row["layout_position"]
        let layoutPosition: LayoutPosition? = try layoutPositionJSON.map {
            try JSONDecoder().decode(LayoutPosition.self, from: Data($0.utf8))
        }
        self.init(
            id: TerminalID(rawValue: idStr),
            spaceID: SpaceID(rawValue: spaceIDStr),
            cwd: cwd,
            command: command,
            status: status,
            claudeSessionID: ccSessionIDStr.map { SessionID(rawValue: $0) },
            layoutPosition: layoutPosition,
            createdAt: Date(timeIntervalSinceReferenceDate: createdAtInterval)
        )
    }

    func encodedLayoutPosition() throws -> String? {
        guard let pos = layoutPosition else { return nil }
        let data = try JSONEncoder().encode(pos)
        return String(data: data, encoding: .utf8)
    }
}
