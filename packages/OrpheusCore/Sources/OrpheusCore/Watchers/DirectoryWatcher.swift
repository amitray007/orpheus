import Foundation

/// An event emitted by `DirectoryWatcher` when the contents of the watched
/// directory subtree change.
internal enum DirectoryEvent: Sendable {
    case fileAdded(URL)
    case fileModified(URL)
    case fileRemoved(URL)
}

/// Watches a directory **and its immediate subdirectories** for file
/// additions, modifications, and removals.
///
/// Implementation: DispatchSources on the root directory and each immediate
/// subdirectory detect changes.  A debounce timer coalesces rapid events into
/// one diff scan.
///
/// The public `events()` method returns an `AsyncStream<DirectoryEvent>`.
/// Internally, events are also stored in a bounded pending buffer so that a
/// new consumer created after a previous one was cancelled can replay any
/// events that arrived in the interim.
///
/// - Note: `internal` — Group 5 and future groups use this type.
internal actor DirectoryWatcher {

    private let path: String
    private let debounce: TimeInterval

    private let store: EventStore
    private var watcherTask: Task<Void, Never>?

    internal init(path: String, debounce: TimeInterval = 0.250) {
        self.path = path
        self.debounce = debounce
        self.store = EventStore()
    }

    /// Returns an `AsyncStream<DirectoryEvent>` that emits events.
    ///
    /// Calling `events()` cancels any previous watcher and starts a fresh one.
    /// Events from the new watcher are buffered internally; a consumer that
    /// creates a new iterator after a previous one was cancelled will receive
    /// any events that were buffered during the gap.
    internal func events() -> AsyncStream<DirectoryEvent> {
        watcherTask?.cancel()
        watcherTask = nil

        // Synchronously reset the store before starting the new watcher task.
        store.reset()

        let capturedPath     = path
        let capturedDebounce = debounce
        let capturedStore    = store

        watcherTask = Task {
            await Self.runWatcher(
                path: capturedPath,
                debounce: capturedDebounce,
                store: capturedStore
            )
        }

        // Create the stream and register its continuation in the store.
        // The closure runs synchronously during stream init.
        let stream = AsyncStream<DirectoryEvent> { continuation in
            // This closure runs synchronously inside AsyncStream.init,
            // before any values are produced by the watcher task.
            capturedStore.addSubscriber(continuation)
        }
        return stream
    }

    /// Stop the watcher and finish all subscriber streams.
    internal func stop() async {
        watcherTask?.cancel()
        watcherTask = nil
        store.finish()
    }

    // MARK: - Event store

    /// Thread-safe event store that buffers events and fans them out to
    /// registered AsyncStream continuations.
    ///
    /// Key design: events are buffered AND sent to live continuations.
    /// When a new continuation is registered (after a previous one's consumer
    /// was cancelled), buffered events are immediately replayed so the new
    /// consumer doesn't miss anything.
    ///
    /// @unchecked Sendable: all access serialised by `lock`.
    private final class EventStore: @unchecked Sendable {
        private let lock = NSLock()
        private var buffer: [DirectoryEvent] = []
        private var subscribers: [UUID: AsyncStream<DirectoryEvent>.Continuation] = [:]
        private var isFinished = false

        func reset() {
            lock.withLock {
                buffer.removeAll()
                isFinished = false
                for cont in subscribers.values { cont.finish() }
                subscribers.removeAll()
            }
        }

        func send(_ event: DirectoryEvent) {
            lock.withLock {
                guard !isFinished else { return }
                buffer.append(event)
                for cont in subscribers.values { _ = cont.yield(event) }
            }
        }

        func finish() {
            lock.withLock {
                isFinished = true
                for cont in subscribers.values { cont.finish() }
                subscribers.removeAll()
            }
        }

        func addSubscriber(_ continuation: AsyncStream<DirectoryEvent>.Continuation) {
            let id = UUID()
            lock.lock()
            defer { lock.unlock() }

            if isFinished {
                continuation.finish()
                return
            }
            // Replay buffered events to the new subscriber.
            for event in buffer { _ = continuation.yield(event) }
            subscribers[id] = continuation
            // The onTermination closure must NOT acquire `lock` directly
            // because it may fire inside `finish()` while `lock` is already
            // held → deadlock. Hop to a background queue first.
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                DispatchQueue.global(qos: .utility).async {
                    self.lock.lock()
                    self.subscribers.removeValue(forKey: id)
                    self.lock.unlock()
                }
            }
        }
    }

    // MARK: - Signal box for DispatchSources

    /// Signals shared by all DispatchSources — @unchecked Sendable via NSLock.
    private final class SignalBox: @unchecked Sendable {
        private let lock = NSLock()
        private var cont: AsyncStream<Void>.Continuation?
        func set(_ c: AsyncStream<Void>.Continuation) { lock.withLock { cont = c } }
        func signal() { lock.withLock { _ = cont?.yield() } }
        func finish() { lock.withLock { cont?.finish(); cont = nil } }
    }

    // MARK: - Core watch loop

    private static func runWatcher(
        path: String,
        debounce: TimeInterval,
        store: EventStore
    ) async {
        var snapshot: [String: Date] = [:]
        let fm = FileManager.default

        // Phase 1: poll until the root directory exists.
        while !fm.fileExists(atPath: path) {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if Task.isCancelled { break }
        }
        if Task.isCancelled { return }

        // Baseline snapshot (no events for pre-existing files).
        snapshot = scanDirectory(at: path)

        // Phase 2: watch loop.
        while !Task.isCancelled {
            let signalBox = SignalBox()
            let (signalStream, signalCont) = AsyncStream<Void>.makeStream()
            signalBox.set(signalCont)

            var sources: [DispatchSourceFileSystemObject] = []

            func attachSource(for watchedPath: String) {
                let fd = Foundation.open(watchedPath, O_EVTONLY)
                guard fd >= 0 else { return }
                let src = DispatchSource.makeFileSystemObjectSource(
                    fileDescriptor: fd,
                    eventMask: [.write, .delete, .rename, .extend],
                    queue: .global(qos: .utility)
                )
                src.setEventHandler { signalBox.signal() }
                src.setCancelHandler { Foundation.close(fd) }
                sources.append(src)
                src.resume()
            }

            // Watch root directory and each immediate subdirectory.
            attachSource(for: path)
            if let subs = try? fm.contentsOfDirectory(atPath: path) {
                for sub in subs {
                    let subPath = (path as NSString).appendingPathComponent(sub)
                    var isDir: ObjCBool = false
                    if fm.fileExists(atPath: subPath, isDirectory: &isDir), isDir.boolValue {
                        attachSource(for: subPath)
                    }
                }
            }

            // Wait for a signal OR a safety timeout.
            // Safety timeout guarantees a scan even if DispatchSource events
            // self-cancel before the debounce fires (e.g. atomic rename).
            await withTaskGroup(of: Void.self) { group in
                group.addTask {
                    for await _ in signalStream { break }
                }
                group.addTask {
                    try? await Task.sleep(
                        nanoseconds: UInt64((debounce + 0.500) * 1_000_000_000)
                    )
                }
                await group.next()
                group.cancelAll()
            }

            if Task.isCancelled { break }

            // Debounce: let the FS settle.
            try? await Task.sleep(nanoseconds: UInt64(debounce * 1_000_000_000))
            if Task.isCancelled { break }

            // Tear down sources.
            signalBox.finish()
            for src in sources { src.cancel() }

            // Scan and emit diffs.
            let newSnap = scanDirectory(at: path)
            let events = diff(old: snapshot, new: newSnap, root: path)
            snapshot = newSnap
            for e in events { store.send(e) }

            // Handle root directory disappearance.
            if !fm.fileExists(atPath: path) {
                while !fm.fileExists(atPath: path) {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    if Task.isCancelled { break }
                }
                if Task.isCancelled { break }
                snapshot = [:]
            }
        }

        store.finish()
    }

    // MARK: - Directory scanning helpers

    internal static func scanDirectory(at root: String) -> [String: Date] {
        var result: [String: Date] = [:]
        let fm = FileManager.default
        guard let topEntries = try? fm.contentsOfDirectory(atPath: root) else {
            return result
        }
        for entry in topEntries {
            let entryPath = (root as NSString).appendingPathComponent(entry)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: entryPath, isDirectory: &isDir) else { continue }

            if isDir.boolValue {
                guard let subEntries = try? fm.contentsOfDirectory(atPath: entryPath) else { continue }
                for subEntry in subEntries {
                    let subPath = (entryPath as NSString).appendingPathComponent(subEntry)
                    var subIsDir: ObjCBool = false
                    guard fm.fileExists(atPath: subPath, isDirectory: &subIsDir),
                          !subIsDir.boolValue else { continue }
                    let rel = entry + "/" + subEntry
                    if let mt = mtime(of: subPath) {
                        result[rel] = mt
                    }
                }
            } else {
                if let mt = mtime(of: entryPath) {
                    result[entry] = mt
                }
            }
        }
        return result
    }

    internal static func mtime(of path: String) -> Date? {
        // Use FileManager.attributesOfItem instead of URL.resourceValues to
        // bypass the URL resource-attribute cache which can return stale values
        // immediately after an atomic write (rename).
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        return attrs?[.modificationDate] as? Date
    }

    internal static func diff(
        old: [String: Date],
        new: [String: Date],
        root: String
    ) -> [DirectoryEvent] {
        var events: [DirectoryEvent] = []
        let rootURL = URL(fileURLWithPath: root)

        for (rel, newMtime) in new {
            let url = rootURL.appendingPathComponent(rel)
            if let oldMtime = old[rel] {
                if newMtime != oldMtime {
                    events.append(.fileModified(url))
                }
            } else {
                events.append(.fileAdded(url))
            }
        }
        for rel in old.keys where new[rel] == nil {
            let url = rootURL.appendingPathComponent(rel)
            events.append(.fileRemoved(url))
        }
        return events
    }
}
