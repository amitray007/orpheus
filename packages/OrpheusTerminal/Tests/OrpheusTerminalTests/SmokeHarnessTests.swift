import XCTest
@testable import OrpheusTerminal

/// Regression guard: confirms the engine + surface can be constructed in
/// test mode without running an AppKit run loop.
///
/// This test does NOT open a window or run the run loop.
@MainActor
final class SmokeHarnessTests: XCTestCase {

    func testEngineAndSurfaceConstructWithoutRunLoop() throws {
        let engine = OrpheusTerminalEngine.shared
        let config = SurfaceConfig(
            command: "/bin/echo",
            arguments: ["smoke-test"],
            cwd: FileManager.default.homeDirectoryForCurrentUser,
            palette: .orpheusDefault
        )
        let surface = try engine.makeSurface(config: config)
        XCTAssertNotNil(surface.view)
        surface.close()
    }

    func testDefaultSurfaceConfigResolvesShell() {
        let config = SurfaceConfig()
        let resolved = config.resolvedCommand
        XCTAssertFalse(resolved.isEmpty)
        // Should start with '/' (absolute path)
        XCTAssertTrue(resolved.hasPrefix("/"), "resolved command should be absolute: \(resolved)")
    }
}
