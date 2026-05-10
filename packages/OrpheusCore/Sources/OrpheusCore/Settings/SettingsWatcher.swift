import Foundation

/// Watches the global and (optionally) per-project settings files for changes
/// and publishes the merged `OrpheusSettings` on an `AsyncStream`.
///
/// The debounce window is `SettingsConstants.settingsDebounceInterval` (250 ms).
/// File-not-found at start time is handled gracefully: watching begins as soon
/// as each path appears on disk.
///
/// ## Usage
/// ```swift
/// let watcher = SettingsWatcher(globalURL: globalURL, projectURL: projectURL)
/// for await settings in await watcher.start() {
///     applySettings(settings)
/// }
/// ```
public actor SettingsWatcher {

    private let globalURL: URL
    private let projectURL: URL?
    private let loader: SettingsLoader
    private let merger: SettingsMerger

    private var watchTask: Task<Void, Never>?
    private var continuation: AsyncStream<OrpheusSettings>.Continuation?

    public init(
        globalURL: URL,
        projectURL: URL?,
        loader: SettingsLoader = .init(),
        merger: SettingsMerger = .init()
    ) {
        self.globalURL = globalURL
        self.projectURL = projectURL
        self.loader = loader
        self.merger = merger
    }

    /// Start watching and return a stream of merged settings.
    ///
    /// The first value emitted is the current merged view (before any file
    /// changes).  Subsequent values arrive within ~`SettingsConstants.settingsDebounceInterval`
    /// after the last filesystem event on either watched file.
    ///
    /// If a load throws (corrupt JSON) the emission is suppressed and the
    /// previous value is kept; the error is logged via `OrpheusLogger.settings`.
    ///
    /// Calling `start()` again while already running replaces the previous
    /// stream.
    public func start() -> AsyncStream<OrpheusSettings> {
        watchTask?.cancel()
        watchTask = nil
        continuation?.finish()
        continuation = nil

        var localContinuation: AsyncStream<OrpheusSettings>.Continuation!
        let stream = AsyncStream<OrpheusSettings> { cont in
            localContinuation = cont
        }
        self.continuation = localContinuation

        let globalURL    = self.globalURL
        let projectURL   = self.projectURL
        let loader       = self.loader
        let merger       = self.merger
        let cont         = localContinuation!

        watchTask = Task {
            await Self.runWatcher(
                globalURL: globalURL,
                projectURL: projectURL,
                loader: loader,
                merger: merger,
                continuation: cont
            )
        }

        return stream
    }

    /// Stop watching and finish the stream.
    public func stop() async {
        watchTask?.cancel()
        watchTask = nil
        continuation?.finish()
        continuation = nil
    }

    // MARK: - Watch loop

    private static func runWatcher(
        globalURL: URL,
        projectURL: URL?,
        loader: SettingsLoader,
        merger: SettingsMerger,
        continuation: AsyncStream<OrpheusSettings>.Continuation
    ) async {
        // Emit the current merged view immediately.
        if let current = try? loadMerged(
            globalURL: globalURL,
            projectURL: projectURL,
            loader: loader,
            merger: merger
        ) {
            continuation.yield(current)
        }

        let globalWatcher  = FileChangeWatcher(path: globalURL.path)
        let projectWatcher = projectURL.map { FileChangeWatcher(path: $0.path) }

        let globalEvents  = await globalWatcher.events()
        let projectEvents = await projectWatcher?.events()

        // Merge both streams into one channel via a Task group.
        // Each child task forwards events to an AsyncStream<Void>.
        let merged: AsyncStream<Void> = {
            var mergedCont: AsyncStream<Void>.Continuation!
            let stream = AsyncStream<Void> { mergedCont = $0 }
            Task {
                for await _ in globalEvents {
                    mergedCont.yield()
                }
            }
            if let pEvents = projectEvents {
                Task {
                    for await _ in pEvents {
                        mergedCont.yield()
                    }
                }
            }
            return stream
        }()

        for await _ in merged {
            if Task.isCancelled { break }
            do {
                let settings = try loadMerged(
                    globalURL: globalURL,
                    projectURL: projectURL,
                    loader: loader,
                    merger: merger
                )
                continuation.yield(settings)
            } catch {
                OrpheusLogger.settings.error(
                    "SettingsWatcher: failed to reload settings — \(error.localizedDescription, privacy: .public)"
                )
                // Suppress; keep previous value.
            }
        }

        await globalWatcher.stop()
        if let pw = projectWatcher { await pw.stop() }
        continuation.finish()
    }

    // MARK: - Helpers

    private static func loadMerged(
        globalURL: URL,
        projectURL: URL?,
        loader: SettingsLoader,
        merger: SettingsMerger
    ) throws -> OrpheusSettings {
        let global  = try loader.loadGlobal(from: globalURL)
        let project = try projectURL.map { try loader.loadProject(from: $0) }
            ?? .defaultValue
        return merger.merge(global: global, project: project)
    }
}
