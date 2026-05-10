import Foundation

/// A reusable FSEvents-style file watcher backed by `DispatchSource`.
///
/// Emits a debounced `Void` event on an `AsyncStream` whenever the watched
/// file changes.  Callers are responsible for re-reading the file after each
/// emission.
///
/// ## File-not-found handling
/// If the target path does not exist when `events()` is called, the watcher
/// polls for the file's appearance on a 1-second interval.  Once it appears,
/// an event is emitted immediately (so callers can load the newly-created
/// file) and the DispatchSource is registered to watch for further changes.
/// If the file is subsequently deleted, the watcher closes the file descriptor
/// and resumes polling.  This handles the common case where a user creates
/// `.orpheus/config.json` while Orpheus is already running.
///
/// - Note: Marked `internal`; Group 5 (Sessions / JSONL watcher) reuses this
///   type as an implementation detail of the package.
internal actor FileChangeWatcher {

    private let path: String
    private let debounce: TimeInterval

    private var continuation: AsyncStream<Void>.Continuation?
    private var watcherTask: Task<Void, Never>?

    internal init(path: String, debounce: TimeInterval = 0.250) {
        self.path = path
        self.debounce = debounce
    }

    /// Returns an `AsyncStream<Void>` that emits once per debounced change.
    internal func events() -> AsyncStream<Void> {
        watcherTask?.cancel()
        watcherTask = nil
        continuation?.finish()
        continuation = nil

        var localContinuation: AsyncStream<Void>.Continuation!
        let stream = AsyncStream<Void> { cont in
            localContinuation = cont
        }
        self.continuation = localContinuation

        let capturedPath     = path
        let capturedDebounce = debounce
        let cont             = localContinuation!

        watcherTask = Task {
            await Self.runWatcher(
                path: capturedPath,
                debounce: capturedDebounce,
                continuation: cont
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

    // MARK: - Core watch loop

    private static func runWatcher(
        path: String,
        debounce: TimeInterval,
        continuation: AsyncStream<Void>.Continuation
    ) async {
        var debounceTask: Task<Void, Never>?

        func scheduleEmit() {
            debounceTask?.cancel()
            debounceTask = Task {
                try? await Task.sleep(nanoseconds: UInt64(debounce * 1_000_000_000))
                if !Task.isCancelled { continuation.yield() }
            }
        }

        var fileWasMissing = !FileManager.default.fileExists(atPath: path)

        while !Task.isCancelled {
            // Phase 1: poll until the file exists.
            while !FileManager.default.fileExists(atPath: path) {
                fileWasMissing = true
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { break }
            }
            if Task.isCancelled { break }

            // Phase 2: open the file descriptor.
            let fd = Foundation.open(path, O_EVTONLY)
            guard fd >= 0 else {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                continue
            }

            // Emit on file appearance.
            if fileWasMissing {
                scheduleEmit()
                fileWasMissing = false
            }

            // Phase 3: watch with a DispatchSource.
            //
            // Cancellation safety: withTaskCancellationHandler fires onCancel
            // immediately if the task is already cancelled.  We must avoid a
            // deadlock between setting box.inner (under the lock) and the cancel
            // handler calling box.resume() (which also acquires the lock).
            //
            // Solution: set inner BEFORE acquiring any lock, then call
            // source.resume() — which may fire the cancel handler synchronously.
            // The cancel handler reads box.inner (under the lock) but does NOT
            // need the outer code to release any lock first.

            let source = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: fd,
                eventMask: [.write, .delete, .rename, .attrib],
                queue: .global(qos: .utility)
            )

            // Box bridges the DispatchSource cancel callback to the async world.
            // @unchecked Sendable: NSLock serialises all access.
            final class Box: @unchecked Sendable {
                var inner: CheckedContinuation<Void, Never>?
                private var resumed = false
                private let lock = NSLock()

                func setInner(_ c: CheckedContinuation<Void, Never>) {
                    lock.withLock { inner = c }
                }

                func resume() {
                    lock.withLock {
                        guard !resumed else { return }
                        resumed = true
                        inner?.resume()
                    }
                }
            }
            let box = Box()

            // Register event and cancel handlers BEFORE entering
            // withTaskCancellationHandler so that source.cancel() (called by
            // onCancel) finds the cancel handler already registered.
            source.setEventHandler {
                let mask = source.data
                scheduleEmit()
                if mask.contains(.delete) || mask.contains(.rename) {
                    source.cancel()
                }
            }

            source.setCancelHandler {
                Foundation.close(fd)
                box.resume()   // safe: inner is set before source.resume()
            }

            await withTaskCancellationHandler {
                await withCheckedContinuation { (inner: CheckedContinuation<Void, Never>) in
                    // Store the continuation BEFORE calling source.resume().
                    // source.resume() on an already-cancelled source fires the
                    // cancel handler synchronously on the current thread.
                    // The cancel handler calls box.resume() → box.inner?.resume().
                    // If we set inner after resume(), the handler finds inner=nil
                    // and the continuation leaks → permanent hang.
                    //
                    // By setting inner first (no lock conflict here — no other
                    // code holds the box lock at this point), the cancel handler
                    // finds the continuation and resumes it correctly.
                    box.setInner(inner)
                    source.resume()
                    // If already cancelled, cancel handler fired above and called
                    // inner.resume(), so withCheckedContinuation returns now.
                }
            } onCancel: {
                // Called by Swift runtime if task is already cancelled when we
                // enter withTaskCancellationHandler, or if cancelled during wait.
                source.cancel()
                // → fires the cancel handler → close(fd) + box.resume() → inner.resume()
            }

            if Task.isCancelled { break }
            // File deleted/renamed → resume poll loop.
            fileWasMissing = true
        }

        debounceTask?.cancel()
        continuation.finish()
    }
}
