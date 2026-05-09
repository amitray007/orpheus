import GRDB

/// Registers the complete v0 schema as a set of individual, additive migrations.
///
/// Each migration has a unique, timestamped identifier so the history is
/// human-readable and sorts meaningfully.  Once a migration ships it is never
/// edited — add a new one to fix a previous migration.
enum Migrations {

    static func makeMigrator() -> DatabaseMigrator {
        var migrator = DatabaseMigrator()

        // ── 2026-05-10-create-projects ──────────────────────────────────────
        migrator.registerMigration("2026-05-10-create-projects") { db in
            try db.create(table: "projects") { t in
                t.primaryKey("id", .text).notNull()
                t.column("name", .text).notNull()
                t.column("root_path", .text).notNull()
                t.column("lifecycle_state", .text).notNull()
                t.column("tags", .text).notNull()          // JSON [String]
                t.column("created_at", .double).notNull()  // timeIntervalSinceReferenceDate
                t.column("updated_at", .double).notNull()
            }
        }

        // ── 2026-05-10-create-spaces ────────────────────────────────────────
        migrator.registerMigration("2026-05-10-create-spaces") { db in
            try db.create(table: "spaces") { t in
                t.primaryKey("id", .text).notNull()
                t.column("project_id", .text)
                    .notNull()
                    .references("projects", onDelete: .cascade)
                t.column("name", .text).notNull()
                t.column("description", .text)             // nullable
                t.column("layout_spec", .text).notNull()   // JSON LayoutSpec
                t.column("ord", .integer).notNull()        // "order" is reserved
                t.column("lifecycle_state", .text).notNull()
                t.column("created_at", .double).notNull()
                t.column("updated_at", .double).notNull()
            }
        }

        // ── 2026-05-10-create-terminals ─────────────────────────────────────
        migrator.registerMigration("2026-05-10-create-terminals") { db in
            try db.create(table: "terminals") { t in
                t.primaryKey("id", .text).notNull()
                t.column("space_id", .text)
                    .notNull()
                    .references("spaces", onDelete: .cascade)
                t.column("cwd", .text).notNull()
                t.column("command", .text)                 // nullable
                t.column("status", .text).notNull()
                t.column("cc_session_id", .text)           // nullable SessionID
                t.column("layout_position", .text)         // JSON LayoutPosition?, nullable
                t.column("created_at", .double).notNull()
            }
        }

        // ── 2026-05-10-create-terminal-scrollback ───────────────────────────
        migrator.registerMigration("2026-05-10-create-terminal-scrollback") { db in
            try db.create(table: "terminal_scrollback") { t in
                t.column("terminal_id", .text)
                    .notNull()
                    .references("terminals", onDelete: .cascade)
                t.column("chunk_index", .integer).notNull()
                t.column("bytes", .blob).notNull()
                t.primaryKey(["terminal_id", "chunk_index"])
            }
        }

        // ── 2026-05-10-create-sessions-index ────────────────────────────────
        // FTS5 virtual table for cross-project session search.
        // `last_updated UNINDEXED` stores an ISO 8601 timestamp without
        // tokenising it, keeping the index lean.
        migrator.registerMigration("2026-05-10-create-sessions-index") { db in
            try db.create(virtualTable: "sessions_index", using: FTS5()) { t in
                t.column("cwd")
                t.column("name")
                t.column("git_branch")
                t.column("last_updated").notIndexed()
            }
        }

        // ── 2026-05-10-create-app-state ─────────────────────────────────────
        migrator.registerMigration("2026-05-10-create-app-state") { db in
            try db.create(table: "app_state") { t in
                t.primaryKey("key", .text).notNull()
                t.column("value", .text).notNull()   // JSON-encoded; callers own the encoding
            }
        }

        return migrator
    }
}
