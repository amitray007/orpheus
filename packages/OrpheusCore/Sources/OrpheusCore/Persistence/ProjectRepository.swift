import Foundation
import GRDB

/// Stores and retrieves `Project` records from SQLite.
///
/// All SQL is confined to this file — no GRDB types leak into `Model/`.
/// Row-to-model mapping is done manually so `Project` stays clean Swift.
public actor ProjectRepository {

    private let database: Database

    public init(database: Database) {
        self.database = database
    }

    // MARK: - CRUD

    public func fetchAll() async throws -> [Project] {
        try await database.read { db in
            let rows = try Row.fetchAll(db, sql: "SELECT * FROM projects ORDER BY created_at ASC")
            return try rows.map { try Project(row: $0) }
        }
    }

    public func fetch(id: ProjectID) async throws -> Project? {
        try await database.read { db in
            let row = try Row.fetchOne(
                db,
                sql: "SELECT * FROM projects WHERE id = ?",
                arguments: [id.rawValue]
            )
            return try row.map { try Project(row: $0) }
        }
    }

    public func create(_ project: Project) async throws {
        try await database.write { db in
            try db.execute(
                sql: """
                    INSERT INTO projects (id, name, root_path, lifecycle_state, tags, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                arguments: [
                    project.id.rawValue,
                    project.name,
                    project.rootPath,
                    project.lifecycleState.rawValue,
                    try project.encodedTags(),
                    project.createdAt.timeIntervalSinceReferenceDate,
                    project.updatedAt.timeIntervalSinceReferenceDate,
                ]
            )
        }
    }

    public func update(_ project: Project) async throws {
        let affected = try await database.write { db -> Int in
            try db.execute(
                sql: """
                    UPDATE projects
                    SET name = ?, root_path = ?, lifecycle_state = ?, tags = ?, updated_at = ?
                    WHERE id = ?
                    """,
                arguments: [
                    project.name,
                    project.rootPath,
                    project.lifecycleState.rawValue,
                    try project.encodedTags(),
                    project.updatedAt.timeIntervalSinceReferenceDate,
                    project.id.rawValue,
                ]
            )
            return db.changesCount
        }
        if affected == 0 {
            throw OrpheusCoreError.notFound(id: project.id.rawValue, kind: "Project")
        }
    }

    public func delete(id: ProjectID) async throws {
        try await database.write { db in
            try db.execute(
                sql: "DELETE FROM projects WHERE id = ?",
                arguments: [id.rawValue]
            )
        }
    }

    // MARK: - Observation

    /// Emits the full list of projects whenever any project row changes.
    /// Uses GRDB `ValueObservation`; values arrive on a background queue.
    public func observeAll() -> AsyncStream<[Project]> {
        let dbWriter = database.writer
        return AsyncStream { continuation in
            let observation = ValueObservation.tracking { db -> [Project] in
                let rows = try Row.fetchAll(db, sql: "SELECT * FROM projects ORDER BY created_at ASC")
                return try rows.map { try Project(row: $0) }
            }
            let cancellable = observation.start(
                in: dbWriter,
                scheduling: .async(onQueue: .global(qos: .userInitiated)),
                onError: { _ in continuation.finish() },
                onChange: { projects in continuation.yield(projects) }
            )
            continuation.onTermination = { _ in cancellable.cancel() }
        }
    }
}

// MARK: - Row decoding (module-internal)

private extension Project {
    init(row: Row) throws {
        guard
            let idStr = row["id"] as? String,
            let name = row["name"] as? String,
            let rootPath = row["root_path"] as? String,
            let lifecycleRaw = row["lifecycle_state"] as? String,
            let lifecycleState = LifecycleState(rawValue: lifecycleRaw),
            let tagsJSON = row["tags"] as? String,
            let createdAtInterval = row["created_at"] as? Double,
            let updatedAtInterval = row["updated_at"] as? Double
        else {
            throw OrpheusCoreError.persistenceFailed(reason: "Corrupt project row")
        }
        let tags = (try? JSONDecoder().decode([String].self, from: Data(tagsJSON.utf8))) ?? []
        self.init(
            id: ProjectID(rawValue: idStr),
            name: name,
            rootPath: rootPath,
            lifecycleState: lifecycleState,
            tags: tags,
            createdAt: Date(timeIntervalSinceReferenceDate: createdAtInterval),
            updatedAt: Date(timeIntervalSinceReferenceDate: updatedAtInterval)
        )
    }

    func encodedTags() throws -> String {
        let data = try JSONEncoder().encode(tags)
        return String(data: data, encoding: .utf8) ?? "[]"
    }
}
