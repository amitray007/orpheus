import XCTest
import Foundation
@testable import OrpheusCore

final class SettingsWatcherTests: XCTestCase {

    private var tmpDir: URL!
    private let loader = SettingsLoader()
    private let merger = SettingsMerger()

    override func setUp() async throws {
        tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("SettingsWatcherTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // MARK: - Helpers

    private func globalURL() -> URL {
        tmpDir.appendingPathComponent("global-config.json")
    }

    private func projectURL() -> URL {
        tmpDir.appendingPathComponent("project-config.json")
    }

    private func write(_ settings: OrpheusSettings, to url: URL) throws {
        try loader.write(settings, to: url)
    }

    // MARK: - Start emits current view immediately

    func testStartEmitsCurrentView() async throws {
        var global = OrpheusSettings.defaultValue
        global.general.theme = .dark
        try write(global, to: globalURL())

        let watcher = SettingsWatcher(
            globalURL: globalURL(),
            projectURL: nil,
            loader: loader,
            merger: merger
        )
        let stream = await watcher.start()

        let first = await firstValue(from: stream, timeout: 1.5)
        XCTAssertNotNil(first)
        XCTAssertEqual(first?.general.theme, .dark)

        await watcher.stop()
    }

    // MARK: - Mutating global file emits new merged view

    func testMutatingGlobalFileEmitsNewView() async throws {
        var global = OrpheusSettings.defaultValue
        global.general.theme = .light
        try write(global, to: globalURL())

        let watcher = SettingsWatcher(
            globalURL: globalURL(),
            projectURL: nil,
            loader: loader,
            merger: merger
        )
        let stream = await watcher.start()

        // Consume the initial emission.
        _ = await firstValue(from: stream, timeout: 1.0)

        // Mutate the global file.
        var updated = OrpheusSettings.defaultValue
        updated.general.theme = .dark
        try write(updated, to: globalURL())

        // Expect a new emission within ~500 ms (debounce 250 ms + slack).
        let second = await firstValue(from: stream, timeout: 1.5)
        XCTAssertNotNil(second, "Expected emission after global file change")
        XCTAssertEqual(second?.general.theme, .dark)

        await watcher.stop()
    }

    // MARK: - Mutating project file emits new merged view

    func testMutatingProjectFileEmitsNewView() async throws {
        var global = OrpheusSettings.defaultValue
        global.general.theme = .dark
        try write(global, to: globalURL())

        var project = OrpheusSettings.defaultValue
        project.terminal.colorScheme = "nord"
        try write(project, to: projectURL())

        let watcher = SettingsWatcher(
            globalURL: globalURL(),
            projectURL: projectURL(),
            loader: loader,
            merger: merger
        )
        let stream = await watcher.start()

        // Consume the initial emission.
        _ = await firstValue(from: stream, timeout: 1.0)

        // Mutate the project file.
        var updatedProject = OrpheusSettings.defaultValue
        updatedProject.terminal.colorScheme = "solarized-dark"
        try write(updatedProject, to: projectURL())

        // Expect emission within ~500 ms.
        let second = await firstValue(from: stream, timeout: 1.5)
        XCTAssertNotNil(second, "Expected emission after project file change")
        XCTAssertEqual(second?.general.theme, .dark)
        XCTAssertEqual(second?.terminal.colorScheme, "solarized-dark")

        await watcher.stop()
    }

    // MARK: - Project URL nil → only global watched

    func testNilProjectURLWatchesOnlyGlobal() async throws {
        var global = OrpheusSettings.defaultValue
        global.claude.binaryPath = "/usr/bin/claude"
        try write(global, to: globalURL())

        let watcher = SettingsWatcher(
            globalURL: globalURL(),
            projectURL: nil,
            loader: loader,
            merger: merger
        )
        let stream = await watcher.start()

        let first = await firstValue(from: stream, timeout: 1.0)
        XCTAssertEqual(first?.claude.binaryPath, "/usr/bin/claude")

        await watcher.stop()
    }

    // MARK: - Merged view: project overrides global

    func testMergedViewAppliesProjectOverrides() async throws {
        var global = OrpheusSettings.defaultValue
        global.general.theme = .dark
        global.terminal.scrollbackLines = 5_000
        try write(global, to: globalURL())

        var project = OrpheusSettings.defaultValue
        project.terminal.scrollbackLines = 1_000
        try write(project, to: projectURL())

        let watcher = SettingsWatcher(
            globalURL: globalURL(),
            projectURL: projectURL(),
            loader: loader,
            merger: merger
        )
        let stream = await watcher.start()

        let first = await firstValue(from: stream, timeout: 1.0)
        XCTAssertEqual(first?.general.theme, .dark)            // from global
        XCTAssertEqual(first?.terminal.scrollbackLines, 1_000) // from project

        await watcher.stop()
    }

    // MARK: - Start/stop lifecycle

    func testStopFinishesStream() async throws {
        try write(.defaultValue, to: globalURL())

        let watcher = SettingsWatcher(
            globalURL: globalURL(),
            projectURL: nil,
            loader: loader,
            merger: merger
        )
        let stream = await watcher.start()

        // Consume the first value.
        _ = await firstValue(from: stream, timeout: 1.0)

        // Stop should finish the stream.
        await watcher.stop()
        // After stop, the test should return without hanging.
    }

    // MARK: - Coalescing simultaneous changes

    func testSimultaneousChangesCoalesceToSingleEmission() async throws {
        var global = OrpheusSettings.defaultValue
        global.general.theme = .light
        try write(global, to: globalURL())

        var project = OrpheusSettings.defaultValue
        project.terminal.colorScheme = "nord"
        try write(project, to: projectURL())

        let watcher = SettingsWatcher(
            globalURL: globalURL(),
            projectURL: projectURL(),
            loader: loader,
            merger: merger
        )
        let stream = await watcher.start()

        // Consume the initial emission.
        _ = await firstValue(from: stream, timeout: 1.0)

        // Mutate BOTH files in rapid succession (well within the debounce window).
        var newGlobal = OrpheusSettings.defaultValue
        newGlobal.general.theme = .dark
        try write(newGlobal, to: globalURL())

        var newProject = OrpheusSettings.defaultValue
        newProject.terminal.colorScheme = "solarized-dark"
        try write(newProject, to: projectURL())

        // Count emissions over a window long enough for both FCW debounces
        // and the SettingsWatcher coalescing debounce to fire (~750 ms slack).
        let count = await countEmissions(from: stream, duration: 1.5)

        XCTAssertEqual(
            count, 1,
            "Both files changed within the debounce window; expected exactly one merged emission"
        )

        await watcher.stop()
    }

    func testRestartProducesNewStream() async throws {
        try write(.defaultValue, to: globalURL())

        let watcher = SettingsWatcher(
            globalURL: globalURL(),
            projectURL: nil,
            loader: loader,
            merger: merger
        )

        let stream1 = await watcher.start()
        _ = await firstValue(from: stream1, timeout: 1.0)

        // Start again — should produce a fresh stream.
        let stream2 = await watcher.start()
        let second = await firstValue(from: stream2, timeout: 1.5)
        XCTAssertNotNil(second, "Restarted stream should emit an initial value")

        await watcher.stop()
    }
}

// MARK: - Helpers

/// Await the first value from `stream`, returning nil if `timeout` elapses first.
private func firstValue<T: Sendable>(
    from stream: AsyncStream<T>,
    timeout: Double
) async -> T? {
    await withTaskGroup(of: T?.self) { group in
        group.addTask {
            for await value in stream { return value }
            return nil
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            return nil
        }
        let result = await group.next() ?? nil
        group.cancelAll()
        return result
    }
}

/// Lock-protected emission counter. Hoisted to file scope because Swift
/// disallows nesting non-generic types inside generic functions.
private final class EmissionCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func inc() { lock.withLock { n += 1 } }
    var value: Int { lock.withLock { n } }
}

/// Count emissions from `stream` over `duration` seconds. Races the
/// consumer against a sleep timer so a low-event-rate stream cannot
/// block on `for await` waiting for the next value.
private func countEmissions<T: Sendable>(
    from stream: AsyncStream<T>,
    duration: Double
) async -> Int {
    let counter = EmissionCounter()

    await withTaskGroup(of: Void.self) { group in
        group.addTask {
            for await _ in stream { counter.inc() }
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
        }
        await group.next()
        group.cancelAll()
    }
    return counter.value
}
