import Foundation

/// Translates raw `DirectoryEvent` values from the underlying
/// `DirectoryWatcher` into typed `SessionUpdate` events by re-parsing the
/// affected JSONL file.
///
/// Debounce: 100 ms per file (JSONL files mutate more frequently than
/// settings files and the UI wants snappier updates).
///
/// A `path → sessionID` map is maintained so that `.fileRemoved` events can
/// produce a `.removed(SessionID)` without needing to read the deleted file.
internal actor JSONLWatcher {

    private let rootURL: URL
    private let parser: JSONLLineParser
    private let debounce: TimeInterval

    private var continuation: AsyncStream<SessionUpdate>.Continuation?
    private var watcherTask: Task<Void, Never>?

    /// Maps relative path (within `rootURL`) → sessionID for removal tracking.
    private var pathToSessionID: [String: SessionID] = [:]

    internal init(
        rootURL: URL,
        parser: JSONLLineParser = .init(),
        debounce: TimeInterval = 0.100
    ) {
        self.rootURL = rootURL
        self.parser = parser
        self.debounce = debounce
    }

    /// Returns an `AsyncStream<SessionUpdate>` of parsed events.
    internal func events() -> AsyncStream<SessionUpdate> {
        watcherTask?.cancel()
        watcherTask = nil
        continuation?.finish()
        continuation = nil

        var localContinuation: AsyncStream<SessionUpdate>.Continuation!
        let stream = AsyncStream<SessionUpdate> { cont in
            localContinuation = cont
        }
        self.continuation = localContinuation

        let capturedRoot     = rootURL
        let capturedParser   = parser
        let capturedDebounce = debounce

        watcherTask = Task {
            await Self.runWatcher(
                rootURL: capturedRoot,
                parser: capturedParser,
                debounce: capturedDebounce,
                continuation: localContinuation!,
                pathMap: { [weak self] rel, sid in
                    await self?.recordPath(rel, sessionID: sid)
                },
                sessionIDForPath: { [weak self] rel in
                    await self?.sessionID(forPath: rel)
                }
            )
        }

        return stream
    }

    /// Stop the watcher and finish the stream.
    internal func stop() async {
        watcherTask?.cancel()
        watcherTask = nil
        continuation?.finish()
        continuation = nil
    }

    // MARK: - Path map helpers (actor-isolated)

    private func recordPath(_ rel: String, sessionID: SessionID) {
        pathToSessionID[rel] = sessionID
    }

    private func removePath(_ rel: String) {
        pathToSessionID.removeValue(forKey: rel)
    }

    private func sessionID(forPath rel: String) -> SessionID? {
        pathToSessionID[rel]
    }

    // MARK: - Watch loop

    private static func runWatcher(
        rootURL: URL,
        parser: JSONLLineParser,
        debounce: TimeInterval,
        continuation: AsyncStream<SessionUpdate>.Continuation,
        pathMap: @Sendable @escaping (String, SessionID) async -> Void,
        sessionIDForPath: @Sendable @escaping (String) async -> SessionID?
    ) async {
        let dirWatcher = DirectoryWatcher(path: rootURL.path, debounce: 0.050)
        let dirEvents = await dirWatcher.events()

        // Keep track of known session IDs for removal.
        // We maintain a local map too (for lookup within this static func).
        var localPathMap: [String: SessionID] = [:]

        for await event in dirEvents {
            if Task.isCancelled { break }

            switch event {
            case .fileAdded(let url):
                guard url.pathExtension == "jsonl" else { continue }
                let rel = relativePath(of: url, from: rootURL)
                await handleAddedOrModified(
                    url: url,
                    rel: rel,
                    known: localPathMap[rel] != nil,
                    parser: parser,
                    debounce: debounce,
                    continuation: continuation,
                    localPathMap: &localPathMap,
                    pathMap: pathMap
                )

            case .fileModified(let url):
                guard url.pathExtension == "jsonl" else { continue }
                let rel = relativePath(of: url, from: rootURL)
                await handleAddedOrModified(
                    url: url,
                    rel: rel,
                    known: localPathMap[rel] != nil,
                    parser: parser,
                    debounce: debounce,
                    continuation: continuation,
                    localPathMap: &localPathMap,
                    pathMap: pathMap
                )

            case .fileRemoved(let url):
                guard url.pathExtension == "jsonl" else { continue }
                let rel = relativePath(of: url, from: rootURL)
                if let sid = localPathMap[rel] {
                    localPathMap.removeValue(forKey: rel)
                    continuation.yield(.removed(sid))
                }
            }
        }

        await dirWatcher.stop()
        continuation.finish()
    }

    private static func handleAddedOrModified(
        url: URL,
        rel: String,
        known: Bool,
        parser: JSONLLineParser,
        debounce: TimeInterval,
        continuation: AsyncStream<SessionUpdate>.Continuation,
        localPathMap: inout [String: SessionID],
        pathMap: @Sendable @escaping (String, SessionID) async -> Void
    ) async {
        do {
            guard let metadata = try parser.parse(fileURL: url) else { return }
            localPathMap[rel] = metadata.sessionID
            await pathMap(rel, metadata.sessionID)
            if known {
                continuation.yield(.updated(metadata))
            } else {
                continuation.yield(.added(metadata))
            }
        } catch {
            OrpheusLogger.sessions.error(
                "JSONLWatcher: failed to parse \(url.path, privacy: .public) — \(error.localizedDescription, privacy: .public)"
            )
        }
    }

    /// Return the path of `url` relative to `root`, or the absolute path
    /// if `url` is not under `root`.
    private static func relativePath(of url: URL, from root: URL) -> String {
        let rootPath = root.path
        let urlPath = url.path
        if urlPath.hasPrefix(rootPath + "/") {
            return String(urlPath.dropFirst(rootPath.count + 1))
        }
        return urlPath
    }
}
