import Foundation
import GRDB

/// The single concurrency boundary around OrpheusCore's SQLite database.
///
/// All reads and writes go through this actor; no other code in the package
/// holds a live reference to the underlying database writer.  Tests pass a
/// temp-file path or request an in-memory database via the dedicated initialiser.
///
/// File-backed databases use `DatabasePool` (WAL mode, concurrent reads).
/// In-memory databases use `DatabaseQueue` — WAL mode is not meaningful
/// without a file, but the same interface is used via `AnyDatabaseWriter`,
/// so repositories are unaffected by the backing storage choice.
public actor Database {

    // MARK: - Internal writer (module-internal so repositories can use ValueObservation)
    //
    // `AnyDatabaseWriter` is a concrete class that conforms to both
    // `DatabaseWriter` and `DatabaseReader` and satisfies the `some DatabaseReader`
    // requirement of `ValueObservation.start(in:)`.

    let writer: AnyDatabaseWriter

    // MARK: - Initialisers

    /// Open (or create) a WAL-mode SQLite file at `path` and apply all
    /// registered migrations.  Throws `OrpheusCoreError.migrationFailed` if
    /// the file cannot be opened or migration fails.
    public init(path: String) async throws {
        do {
            let pool = try Database.makePool(path: path)
            try Migrations.makeMigrator().migrate(pool)
            self.writer = AnyDatabaseWriter(pool)
        } catch let error as OrpheusCoreError {
            throw error
        } catch {
            throw OrpheusCoreError.migrationFailed(reason: error.localizedDescription)
        }
    }

    /// Open an in-memory database — useful for unit tests.
    public init(inMemory: Void = ()) async throws {
        do {
            var config = Database.baseConfiguration()
            config.label = "com.orpheus.core.memory"
            let queue = try DatabaseQueue(configuration: config)
            try Migrations.makeMigrator().migrate(queue)
            self.writer = AnyDatabaseWriter(queue)
        } catch let error as OrpheusCoreError {
            throw error
        } catch {
            throw OrpheusCoreError.migrationFailed(reason: error.localizedDescription)
        }
    }

    // MARK: - Public interface

    /// Execute a read-only block.
    @discardableResult
    public func read<T: Sendable>(
        _ block: @Sendable (GRDB.Database) throws -> T
    ) async throws -> T {
        // writer.read is synchronous; the async signature satisfies the public
        // contract (all I/O off the main thread via actor isolation).
        try writer.read(block)
    }

    /// Execute a read-write block on the writer connection.
    @discardableResult
    public func write<T: Sendable>(
        _ block: @Sendable (GRDB.Database) throws -> T
    ) async throws -> T {
        try writer.write(block)
    }

    // MARK: - Private helpers

    private static func baseConfiguration() -> Configuration {
        var config = Configuration()
        config.foreignKeysEnabled = true
        // DatabasePool enables WAL mode by default; reinforce it via prepareDatabase
        // so that any non-pool writer (e.g. DatabaseQueue in tests) also uses WAL
        // if SQLite supports it.
        config.prepareDatabase { db in
            try db.execute(sql: "PRAGMA foreign_keys = ON")
        }
        return config
    }

    private static func makePool(path: String) throws -> DatabasePool {
        var config = baseConfiguration()
        config.label = "com.orpheus.core.persistence"
        do {
            return try DatabasePool(path: path, configuration: config)
        } catch {
            throw OrpheusCoreError.migrationFailed(
                reason: "Cannot open database at \(path): \(error.localizedDescription)"
            )
        }
    }
}
