import Foundation

/// Scans `~/.claude/projects/` (or an injected path for tests) for Claude Code
/// session JSONL files, builds an in-memory index, and exposes a live
/// `AsyncStream<SessionUpdate>` of changes.
///
/// ## Lifecycle
///
/// ```swift
/// let registry = SessionRegistry(rootURL: projectsURL)
/// let stream = await registry.updates()
/// try await registry.start()
/// for await update in stream { /* react */ }
/// ```
///
/// Call `updates()` **before** `start()` to receive both the initial-scan
/// snapshot and subsequent watcher events on the same stream.
///
/// `start()` is idempotent: calling it again tears down the previous watcher
/// and rescans from scratch.
public actor SessionRegistry {

    private let rootURL: URL
    private let parser: JSONLLineParser
    private let indexer: SessionsIndexer?

    /// In-memory index: cwd → sessions (sorted by lastUpdated descending).
    private var index: [String: [SessionMetadata]] = [:]

    /// All session IDs in the index (for quick existence checks).
    private var knownSessionIDs: Set<SessionID> = []

    private var continuation: AsyncStream<SessionUpdate>.Continuation?
    private var watcherTask: Task<Void, Never>?

    // MARK: - Init

    public init(
        rootURL: URL,
        parser: JSONLLineParser = .init(),
        indexer: SessionsIndexer? = nil
    ) {
        self.rootURL = rootURL
        self.parser = parser
        self.indexer = indexer
    }

    // MARK: - Stream subscription (must be called BEFORE start())

    /// Return the stream of session updates.
    ///
    /// Calling `updates()` registers the subscriber.  The initial-scan
    /// emissions happen inside `start()`, which must be called **after**
    /// `updates()` so the subscriber doesn't miss the snapshot.
    public func updates() -> AsyncStream<SessionUpdate> {
        // Finish any previous stream before replacing it.
        continuation?.finish()
        continuation = nil

        var localContinuation: AsyncStream<SessionUpdate>.Continuation!
        let stream = AsyncStream<SessionUpdate> { cont in
            localContinuation = cont
        }
        self.continuation = localContinuation
        return stream
    }

    // MARK: - Start / Stop

    /// Scan the root directory, populate the in-memory index, persist to FTS5,
    /// and start the JSONL watcher.
    ///
    /// Emits `.added(metadata)` for every session discovered during the initial
    /// scan on the stream registered by `updates()`.  Watcher events flow into
    /// the same stream after the scan completes.
    ///
    /// Idempotent — calling `start()` again stops the previous watcher and
    /// rescans.
    public func start() async throws {
        // Cancel previous watcher.
        watcherTask?.cancel()
        watcherTask = nil

        // Reset the in-memory index.
        index = [:]
        knownSessionIDs = []

        // Perform the initial scan synchronously (on the actor) so the snapshot
        // is fully emitted before the watcher starts.
        let metadataList = scanRoot()
        for metadata in metadataList {
            add(metadata)
            continuation?.yield(.added(metadata))
            try await indexer?.index(metadata)
        }

        // Wire up the watcher AFTER the snapshot scan.
        let capturedRoot    = rootURL
        let capturedParser  = parser
        let capturedIndexer = indexer
        let cont            = continuation   // may be nil if caller didn't call updates() first

        watcherTask = Task {
            await Self.runWatcher(
                rootURL: capturedRoot,
                parser: capturedParser,
                indexer: capturedIndexer,
                registry: self,
                continuation: cont
            )
        }
    }

    /// Stop the watcher and clear the in-memory index.
    public func stop() async {
        watcherTask?.cancel()
        watcherTask = nil
        continuation?.finish()
        continuation = nil
        index = [:]
        knownSessionIDs = []
    }

    // MARK: - Read APIs

    /// All sessions for the given working directory, sorted by `lastUpdated`
    /// descending.
    public func sessions(forCWD cwd: String) -> [SessionMetadata] {
        index[cwd] ?? []
    }

    /// The `limit` most-recently-updated sessions across all CWDs.
    public func recent(limit: Int) -> [SessionMetadata] {
        let all = index.values.flatMap { $0 }
        let sorted = all.sorted { $0.lastUpdated > $1.lastUpdated }
        return Array(sorted.prefix(limit))
    }

    /// Full-text search.  Delegates to `SessionsIndexer` when present;
    /// otherwise performs a case-insensitive substring match in-memory.
    public func search(_ query: String, limit: Int = 50) async throws -> [SessionMetadata] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        if let indexer {
            let entries = try await indexer.search(query: trimmed, limit: limit)
            // Resolve entries back to in-memory metadata (fresher than FTS5).
            return entries.compactMap { entry in
                index[entry.cwd]?.first { $0.sessionID == entry.sessionID }
            }
        }

        // In-memory fallback.
        let lower = trimmed.lowercased()
        let all = index.values.flatMap { $0 }
        let matched = all.filter { m in
            m.cwd.lowercased().contains(lower)
            || (m.name?.lowercased().contains(lower) ?? false)
            || (m.gitBranch?.lowercased().contains(lower) ?? false)
        }
        return Array(matched.sorted { $0.lastUpdated > $1.lastUpdated }.prefix(limit))
    }

    // MARK: - Internal mutation helpers (called from the watcher task)

    /// Apply an inbound `SessionUpdate`, updating the in-memory index and the
    /// FTS5 index, then forwarding the update to the continuation.
    internal func apply(_ update: SessionUpdate) async {
        switch update {
        case .added(let metadata):
            add(metadata)
            continuation?.yield(.added(metadata))
            try? await indexer?.index(metadata)
        case .updated(let metadata):
            update_(metadata)
            continuation?.yield(.updated(metadata))
            try? await indexer?.index(metadata)
        case .removed(let sid):
            remove(sid)
            continuation?.yield(.removed(sid))
            try? await indexer?.remove(sid)
        }
    }

    // MARK: - In-memory index maintenance

    private func add(_ metadata: SessionMetadata) {
        guard !knownSessionIDs.contains(metadata.sessionID) else {
            update_(metadata)
            return
        }
        knownSessionIDs.insert(metadata.sessionID)
        index[metadata.cwd, default: []].append(metadata)
        index[metadata.cwd]?.sort { $0.lastUpdated > $1.lastUpdated }
    }

    private func update_(_ metadata: SessionMetadata) {
        knownSessionIDs.insert(metadata.sessionID)
        var sessions = index[metadata.cwd] ?? []
        if let idx = sessions.firstIndex(where: { $0.sessionID == metadata.sessionID }) {
            sessions[idx] = metadata
        } else {
            sessions.append(metadata)
        }
        sessions.sort { $0.lastUpdated > $1.lastUpdated }
        index[metadata.cwd] = sessions
    }

    private func remove(_ sessionID: SessionID) {
        knownSessionIDs.remove(sessionID)
        for (cwd, sessions) in index {
            let filtered = sessions.filter { $0.sessionID != sessionID }
            if filtered.count != sessions.count {
                index[cwd] = filtered.isEmpty ? nil : filtered
                return
            }
        }
    }

    // MARK: - Initial scan

    /// Walk `rootURL` one level deep, parse every `.jsonl` file found in
    /// subdirectories, and return the results.
    private func scanRoot() -> [SessionMetadata] {
        let fm = FileManager.default
        guard let topEntries = try? fm.contentsOfDirectory(
            at: rootURL,
            includingPropertiesForKeys: nil
        ) else { return [] }

        var results: [SessionMetadata] = []
        for entry in topEntries {
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: entry.path, isDirectory: &isDir),
                  isDir.boolValue else { continue }
            guard let subEntries = try? fm.contentsOfDirectory(
                at: entry,
                includingPropertiesForKeys: nil
            ) else { continue }
            for file in subEntries where file.pathExtension == "jsonl" {
                do {
                    if let metadata = try parser.parse(fileURL: file) {
                        results.append(metadata)
                    }
                } catch {
                    OrpheusLogger.sessions.error(
                        "SessionRegistry: failed to parse \(file.path, privacy: .public) — \(error.localizedDescription, privacy: .public)"
                    )
                }
            }
        }
        return results
    }

    // MARK: - Watcher loop

    private static func runWatcher(
        rootURL: URL,
        parser: JSONLLineParser,
        indexer: SessionsIndexer?,
        registry: SessionRegistry,
        continuation: AsyncStream<SessionUpdate>.Continuation?
    ) async {
        let watcher = JSONLWatcher(rootURL: rootURL, parser: parser, debounce: 0.100)
        let stream = await watcher.events()

        for await update in stream {
            if Task.isCancelled { break }
            await registry.apply(update)
        }

        await watcher.stop()
    }
}
