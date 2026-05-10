import XCTest
import Foundation
@testable import OrpheusCore

final class SettingsLoaderTests: XCTestCase {

    private var tmpDir: URL!
    private let loader = SettingsLoader()

    override func setUp() async throws {
        tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("SettingsLoaderTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // MARK: - Missing file

    func testLoadGlobalMissingFileReturnsDefault() throws {
        let url = tmpDir.appendingPathComponent("nonexistent.json")
        let settings = try loader.loadGlobal(from: url)
        XCTAssertEqual(settings, OrpheusSettings.defaultValue)
    }

    func testLoadProjectMissingFileReturnsDefault() throws {
        let url = tmpDir.appendingPathComponent("nonexistent.json")
        let settings = try loader.loadProject(from: url)
        XCTAssertEqual(settings, OrpheusSettings.defaultValue)
    }

    // MARK: - Valid file

    func testLoadGlobalValidFile() throws {
        var expected = OrpheusSettings.defaultValue
        expected.general.theme = .dark
        expected.terminal.scrollbackLines = 5_000

        let url = tmpDir.appendingPathComponent("config.json")
        try loader.write(expected, to: url)

        let loaded = try loader.loadGlobal(from: url)
        XCTAssertEqual(loaded, expected)
    }

    func testLoadProjectValidFile() throws {
        var expected = OrpheusSettings.defaultValue
        expected.terminal.colorScheme = "nord"
        expected.claude.binaryPath = "/usr/local/bin/claude"

        let url = tmpDir.appendingPathComponent("project-config.json")
        try loader.write(expected, to: url)

        let loaded = try loader.loadProject(from: url)
        XCTAssertEqual(loaded, expected)
    }

    func testLoadQuickActions() throws {
        var expected = OrpheusSettings.defaultValue
        expected.quickActions = [
            QuickActionDef(id: "qa1", label: "Run Tests", command: "swift test", cwd: .project),
            QuickActionDef(id: "qa2", label: "Open Shell", command: "zsh", cwd: .custom("/tmp"))
        ]
        let url = tmpDir.appendingPathComponent("qa-config.json")
        try loader.write(expected, to: url)

        let loaded = try loader.loadGlobal(from: url)
        XCTAssertEqual(loaded.quickActions.count, 2)
        XCTAssertEqual(loaded.quickActions[0].id, "qa1")
        XCTAssertEqual(loaded.quickActions[1].cwd, .custom("/tmp"))
    }

    // MARK: - Corrupt file

    func testLoadGlobalCorruptFileThrows() throws {
        let url = tmpDir.appendingPathComponent("corrupt.json")
        try "not valid json {{{".data(using: .utf8)!.write(to: url)

        XCTAssertThrowsError(try loader.loadGlobal(from: url)) { error in
            guard case OrpheusCoreError.persistenceFailed(let reason) = error else {
                XCTFail("Expected persistenceFailed, got \(error)")
                return
            }
            XCTAssertTrue(reason.contains("settings decode failed"))
        }
    }

    func testLoadProjectCorruptFileThrows() throws {
        let url = tmpDir.appendingPathComponent("corrupt-project.json")
        try "null".data(using: .utf8)!.write(to: url)

        XCTAssertThrowsError(try loader.loadProject(from: url)) { error in
            guard case OrpheusCoreError.persistenceFailed = error else {
                XCTFail("Expected persistenceFailed, got \(error)")
                return
            }
        }
    }

    // MARK: - Write: atomic (temp + rename)

    func testWriteCreatesFileInMissingDirectory() throws {
        let nestedDir = tmpDir
            .appendingPathComponent("nested")
            .appendingPathComponent("deeply")
        let url = nestedDir.appendingPathComponent("config.json")
        var s = OrpheusSettings.defaultValue
        s.general.theme = .system
        // Should not throw even though the directory tree doesn't exist yet.
        XCTAssertNoThrow(try loader.write(s, to: url))
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    }

    func testWriteIsRoundTrippable() throws {
        var s = OrpheusSettings.defaultValue
        s.general = GeneralSettings(theme: .light, density: .comfortable)
        s.claude.defaultFlags = ["--bare"]
        let url = tmpDir.appendingPathComponent("roundtrip.json")
        try loader.write(s, to: url)
        let loaded = try loader.loadGlobal(from: url)
        XCTAssertEqual(loaded, s)
    }

    func testWriteTempFileNotLeftBehind() throws {
        let url = tmpDir.appendingPathComponent("atomic.json")
        try loader.write(.defaultValue, to: url)
        let tmpURL = tmpDir.appendingPathComponent(".atomic.json.tmp")
        XCTAssertFalse(FileManager.default.fileExists(atPath: tmpURL.path))
    }

    func testOverwriteExistingFile() throws {
        let url = tmpDir.appendingPathComponent("overwrite.json")
        var first = OrpheusSettings.defaultValue
        first.general.theme = .dark
        try loader.write(first, to: url)

        var second = OrpheusSettings.defaultValue
        second.general.theme = .light
        try loader.write(second, to: url)

        let loaded = try loader.loadGlobal(from: url)
        XCTAssertEqual(loaded.general.theme, .light)
    }

    // MARK: - Forward compat: extra keys survive a write+load cycle

    func testExtraKeySurvivesWriteAndLoad() throws {
        let json = """
        {"general":{},"terminal":{},"claude":{},"quickActions":[],"futureFeature":"enabled"}
        """
        let url = tmpDir.appendingPathComponent("extra.json")
        try json.data(using: .utf8)!.write(to: url)

        let loaded = try loader.loadGlobal(from: url)
        XCTAssertNotNil(loaded.extra)

        // Write back and reload — the extra key must survive.
        try loader.write(loaded, to: url)
        let reloaded = try loader.loadGlobal(from: url)
        XCTAssertEqual(reloaded.extra, loaded.extra)
    }
}
