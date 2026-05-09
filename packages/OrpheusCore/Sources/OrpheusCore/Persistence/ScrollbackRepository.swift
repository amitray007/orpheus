import Foundation
import GRDB

/// Stores terminal scrollback in SQLite as bounded 64 KiB chunks.
///
/// Writes are batched to avoid hammering the database with every byte that
/// arrives from a running terminal.  A flush is triggered automatically when
/// - the pending buffer reaches `ScrollbackConstants.scrollbackChunkSize`, or
/// - `ScrollbackConstants.scrollbackFlushInterval` seconds elapse.
///
/// The ring-buffer limit (`ScrollbackConstants.scrollbackRingLimit`) is
/// enforced on flush: the oldest chunk rows are deleted before a new one is
/// inserted when the per-terminal count would exceed the limit.
///
/// **Error semantics:** synchronous flushes (driven by `flush()` or by the
/// chunk-size threshold inside `append()`) propagate write errors directly
/// to the caller.  Deferred flushes (the 250 ms debounce timer) cannot throw,
/// so they record the failure to `lastFlushError`; the next explicit `flush()`
/// surfaces the stored error and clears it.  No DB error is silently lost.
public actor ScrollbackRepository {

    private let database: Database

    // Keyed by terminal ID raw value.
    private var pendingBuffers: [String: Data] = [:]
    private var flushTasks: [String: Task<Void, Never>] = [:]

    /// Most recent error from a deferred-flush task that had no caller to
    /// throw to.  Cleared the next time `flush()` runs successfully.
    private var lastFlushError: OrpheusCoreError?

    public init(database: Database) {
        self.database = database
    }

    // MARK: - Public interface

    /// Append `bytes` to the in-memory buffer for `terminalID`.
    /// A flush is scheduled if one is not already pending, and triggered
    /// immediately if the buffer crosses the chunk-size threshold.
    ///
    /// If the immediate-flush path fails, the error is stored in
    /// `lastFlushError` and surfaced on the next `flush()` call.
    public func append(terminalID: TerminalID, bytes: Data) async {
        let key = terminalID.rawValue
        pendingBuffers[key, default: Data()].append(bytes)

        if pendingBuffers[key]!.count >= ScrollbackConstants.scrollbackChunkSize {
            // Buffer full — flush immediately.
            cancelFlushTask(for: key)
            do {
                try await flushBuffer(for: terminalID)
            } catch let error as OrpheusCoreError {
                lastFlushError = error
                OrpheusLogger.persistence.error(
                    "ScrollbackRepository: deferred-flush error for \(key, privacy: .public): \(error.localizedDescription, privacy: .public)"
                )
            } catch {
                lastFlushError = .migrationFailed(reason: error.localizedDescription)
                OrpheusLogger.persistence.error(
                    "ScrollbackRepository: deferred-flush error for \(key, privacy: .public): \(error.localizedDescription, privacy: .public)"
                )
            }
        } else if flushTasks[key] == nil {
            // Schedule a deferred flush.
            scheduleFlushTask(for: terminalID)
        }
    }

    /// Force-flush pending bytes.  Pass `nil` to flush all terminals.
    ///
    /// Throws on the first DB error encountered.  If a previous deferred
    /// flush failed, that error is surfaced (and cleared) before doing any
    /// new work.
    public func flush(terminalID: TerminalID? = nil) async throws {
        // Surface any deferred-flush error from a previous run.
        if let stored = lastFlushError {
            lastFlushError = nil
            throw stored
        }

        if let id = terminalID {
            cancelFlushTask(for: id.rawValue)
            try await flushBuffer(for: id)
        } else {
            let ids = pendingBuffers.keys.map { TerminalID(rawValue: $0) }
            for id in ids {
                cancelFlushTask(for: id.rawValue)
                try await flushBuffer(for: id)
            }
        }
    }

    /// Return the ordered list of chunk byte-blobs for a terminal.
    public func chunks(terminalID: TerminalID) async throws -> [Data] {
        try await database.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: """
                    SELECT bytes FROM terminal_scrollback
                    WHERE terminal_id = ?
                    ORDER BY chunk_index ASC
                    """,
                arguments: [terminalID.rawValue]
            )
            return rows.compactMap { $0["bytes"] as? Data }
        }
    }

    // MARK: - Private helpers

    private func scheduleFlushTask(for terminalID: TerminalID) {
        let key = terminalID.rawValue
        flushTasks[key] = Task { [weak self] in
            try? await Task.sleep(
                nanoseconds: UInt64(ScrollbackConstants.scrollbackFlushInterval * 1_000_000_000)
            )
            guard let self, !Task.isCancelled else { return }
            await self.deferredFlush(for: terminalID)
        }
    }

    private func cancelFlushTask(for key: String) {
        flushTasks[key]?.cancel()
        flushTasks[key] = nil
    }

    private func clearFlushTask(for key: String) {
        flushTasks[key] = nil
    }

    /// Deferred-flush entry point — has no caller to throw to, so it captures
    /// any error into `lastFlushError` and logs.
    private func deferredFlush(for terminalID: TerminalID) async {
        let key = terminalID.rawValue
        do {
            try await flushBuffer(for: terminalID)
        } catch let error as OrpheusCoreError {
            lastFlushError = error
            OrpheusLogger.persistence.error(
                "ScrollbackRepository: deferred-flush error for \(key, privacy: .public): \(error.localizedDescription, privacy: .public)"
            )
        } catch {
            lastFlushError = .migrationFailed(reason: error.localizedDescription)
            OrpheusLogger.persistence.error(
                "ScrollbackRepository: deferred-flush error for \(key, privacy: .public): \(error.localizedDescription, privacy: .public)"
            )
        }
        clearFlushTask(for: key)
    }

    private func flushBuffer(for terminalID: TerminalID) async throws {
        let key = terminalID.rawValue
        guard let data = pendingBuffers[key], !data.isEmpty else { return }
        pendingBuffers[key] = nil

        // Chunk the buffer — in practice the buffer should already be ≤ chunk
        // size (we flush when it hits the limit), but handle the edge case.
        var offset = 0
        while offset < data.count {
            let end = min(offset + ScrollbackConstants.scrollbackChunkSize, data.count)
            let chunk = data[offset..<end]
            offset = end
            try await writeChunk(Data(chunk), for: terminalID)
        }
    }

    private func writeChunk(_ chunk: Data, for terminalID: TerminalID) async throws {
        // Errors propagate to the caller.  Synchronous-flush callers receive
        // them directly; deferred-flush callers route them into lastFlushError.
        try await database.write { db in
            let tid = terminalID.rawValue

            // Count existing chunks.
            let count = try Int.fetchOne(
                db,
                sql: "SELECT COUNT(*) FROM terminal_scrollback WHERE terminal_id = ?",
                arguments: [tid]
            ) ?? 0

            // Evict oldest chunks when at or beyond the ring limit.
            if count >= ScrollbackConstants.scrollbackRingLimit {
                let overflow = count - ScrollbackConstants.scrollbackRingLimit + 1
                try db.execute(
                    sql: """
                        DELETE FROM terminal_scrollback
                        WHERE terminal_id = ?
                          AND chunk_index IN (
                              SELECT chunk_index FROM terminal_scrollback
                              WHERE terminal_id = ?
                              ORDER BY chunk_index ASC
                              LIMIT ?
                          )
                        """,
                    arguments: [tid, tid, overflow]
                )
            }

            // Determine the next chunk_index (max + 1, or 0 for first chunk).
            let nextIndex = (try Int.fetchOne(
                db,
                sql: "SELECT MAX(chunk_index) FROM terminal_scrollback WHERE terminal_id = ?",
                arguments: [tid]
            ) ?? -1) + 1

            try db.execute(
                sql: """
                    INSERT INTO terminal_scrollback (terminal_id, chunk_index, bytes)
                    VALUES (?, ?, ?)
                    ON CONFLICT(terminal_id, chunk_index) DO UPDATE SET bytes = excluded.bytes
                    """,
                arguments: [tid, nextIndex, chunk]
            )
        }
    }
}
