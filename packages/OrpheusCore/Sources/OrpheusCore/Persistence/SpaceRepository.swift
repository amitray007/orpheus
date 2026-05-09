import Foundation
import GRDB

/// Stores and retrieves `Space` records from SQLite.
///
/// Spaces cascade-delete from their parent Project; the ON DELETE CASCADE
/// constraint is set in the schema migration.
public actor SpaceRepository {

    private let database: Database

    public init(database: Database) {
        self.database = database
    }

    // MARK: - CRUD

    public func fetchAll() async throws -> [Space] {
        try await database.read { db in
            let rows = try Row.fetchAll(db, sql: "SELECT * FROM spaces ORDER BY ord ASC")
            return try rows.map { try Space(row: $0) }
        }
    }

    public func fetch(id: SpaceID) async throws -> Space? {
        try await database.read { db in
            let row = try Row.fetchOne(
                db,
                sql: "SELECT * FROM spaces WHERE id = ?",
                arguments: [id.rawValue]
            )
            return try row.map { try Space(row: $0) }
        }
    }

    /// All spaces belonging to the given project, ordered by `ord`.
    public func fetchByProject(_ projectID: ProjectID) async throws -> [Space] {
        try await database.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: "SELECT * FROM spaces WHERE project_id = ? ORDER BY ord ASC",
                arguments: [projectID.rawValue]
            )
            return try rows.map { try Space(row: $0) }
        }
    }

    public func create(_ space: Space) async throws {
        try await database.write { db in
            try db.execute(
                sql: """
                    INSERT INTO spaces
                    (id, project_id, name, description, layout_spec, ord, lifecycle_state, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                arguments: [
                    space.id.rawValue,
                    space.projectID.rawValue,
                    space.name,
                    space.description,
                    try space.encodedLayoutSpec(),
                    space.ord,
                    space.lifecycleState.rawValue,
                    space.createdAt.timeIntervalSinceReferenceDate,
                    space.updatedAt.timeIntervalSinceReferenceDate,
                ]
            )
        }
    }

    public func update(_ space: Space) async throws {
        let affected = try await database.write { db -> Int in
            try db.execute(
                sql: """
                    UPDATE spaces
                    SET name = ?, description = ?, layout_spec = ?, ord = ?,
                        lifecycle_state = ?, updated_at = ?
                    WHERE id = ?
                    """,
                arguments: [
                    space.name,
                    space.description,
                    try space.encodedLayoutSpec(),
                    space.ord,
                    space.lifecycleState.rawValue,
                    space.updatedAt.timeIntervalSinceReferenceDate,
                    space.id.rawValue,
                ]
            )
            return db.changesCount
        }
        if affected == 0 {
            throw OrpheusCoreError.notFound(id: space.id.rawValue, kind: "Space")
        }
    }

    public func delete(id: SpaceID) async throws {
        try await database.write { db in
            try db.execute(
                sql: "DELETE FROM spaces WHERE id = ?",
                arguments: [id.rawValue]
            )
        }
    }

    // MARK: - Observation

    /// Emits all spaces whenever any space row changes.
    public func observeAll() -> AsyncStream<[Space]> {
        let dbWriter = database.writer
        return AsyncStream { continuation in
            let observation = ValueObservation.tracking { db -> [Space] in
                let rows = try Row.fetchAll(db, sql: "SELECT * FROM spaces ORDER BY ord ASC")
                return try rows.map { try Space(row: $0) }
            }
            let cancellable = observation.start(
                in: dbWriter,
                scheduling: .async(onQueue: .global(qos: .userInitiated)),
                onError: { _ in continuation.finish() },
                onChange: { spaces in continuation.yield(spaces) }
            )
            continuation.onTermination = { _ in cancellable.cancel() }
        }
    }

    /// Emits spaces for a specific project whenever any of their rows change.
    public func observeByProject(_ projectID: ProjectID) -> AsyncStream<[Space]> {
        let dbWriter = database.writer
        let pid = projectID.rawValue
        return AsyncStream { continuation in
            let observation = ValueObservation.tracking { db -> [Space] in
                let rows = try Row.fetchAll(
                    db,
                    sql: "SELECT * FROM spaces WHERE project_id = ? ORDER BY ord ASC",
                    arguments: [pid]
                )
                return try rows.map { try Space(row: $0) }
            }
            let cancellable = observation.start(
                in: dbWriter,
                scheduling: .async(onQueue: .global(qos: .userInitiated)),
                onError: { _ in continuation.finish() },
                onChange: { spaces in continuation.yield(spaces) }
            )
            continuation.onTermination = { _ in cancellable.cancel() }
        }
    }
}

// MARK: - Row decoding (module-internal)

private extension Space {
    init(row: Row) throws {
        // GRDB returns SQLite INTEGER as Int64; use DatabaseValue for safe conversion.
        guard
            let idStr = row["id"] as? String,
            let projectIDStr = row["project_id"] as? String,
            let name = row["name"] as? String,
            let layoutSpecJSON = row["layout_spec"] as? String,
            let lifecycleRaw = row["lifecycle_state"] as? String,
            let lifecycleState = LifecycleState(rawValue: lifecycleRaw)
        else {
            throw OrpheusCoreError.migrationFailed(reason: "Corrupt space row")
        }
        let ordValue: DatabaseValue = row["ord"]
        guard let ord = Int.fromDatabaseValue(ordValue) else {
            throw OrpheusCoreError.migrationFailed(reason: "Corrupt space row: invalid ord")
        }
        let createdAtValue: DatabaseValue = row["created_at"]
        let updatedAtValue: DatabaseValue = row["updated_at"]
        guard
            let createdAtInterval = Double.fromDatabaseValue(createdAtValue),
            let updatedAtInterval = Double.fromDatabaseValue(updatedAtValue)
        else {
            throw OrpheusCoreError.migrationFailed(reason: "Corrupt space row: invalid dates")
        }
        let layoutSpec = try JSONDecoder().decode(
            LayoutSpec.self,
            from: Data(layoutSpecJSON.utf8)
        )
        let description: String? = row["description"]
        self.init(
            id: SpaceID(rawValue: idStr),
            projectID: ProjectID(rawValue: projectIDStr),
            name: name,
            description: description,
            layoutSpec: layoutSpec,
            ord: ord,
            lifecycleState: lifecycleState,
            createdAt: Date(timeIntervalSinceReferenceDate: createdAtInterval),
            updatedAt: Date(timeIntervalSinceReferenceDate: updatedAtInterval)
        )
    }

    func encodedLayoutSpec() throws -> String {
        let data = try JSONEncoder().encode(layoutSpec)
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}
