import XCTest
@testable import OrpheusTerminal

@MainActor
final class EngineTests: XCTestCase {

    func testSharedEngineIsNotNil() {
        let engine = OrpheusTerminalEngine.shared
        XCTAssertNotNil(engine)
    }

    func testSharedEngineReturnsSameInstance() {
        let a = OrpheusTerminalEngine.shared
        let b = OrpheusTerminalEngine.shared
        XCTAssertTrue(a === b, "shared must return the same instance")
    }

    func testMakeSurfaceSucceeds() throws {
        let engine = OrpheusTerminalEngine.shared
        let config = SurfaceConfig(
            command: "/bin/echo",
            arguments: ["hello"],
            palette: .orpheusDefault
        )
        let surface = try engine.makeSurface(config: config)
        XCTAssertNotNil(surface)
        XCTAssertNotNil(surface.view)
        surface.close()
    }

    func testMakeSurfaceWithDefaultConfig() throws {
        let engine = OrpheusTerminalEngine.shared
        let surface = try engine.makeSurface(config: .init())
        XCTAssertNotNil(surface)
        surface.close()
    }

    func testSurfaceCloseDoesNotCrash() throws {
        let engine = OrpheusTerminalEngine.shared
        let surface = try engine.makeSurface(config: .init())
        surface.close()
        // Second close should be a no-op (controller is already nil)
        surface.close()
    }

    func testResolvedCommandFallback() {
        var config = SurfaceConfig()
        config.command = nil
        // resolvedCommand uses $SHELL or /bin/zsh — both should be non-empty
        XCTAssertFalse(config.resolvedCommand.isEmpty)
    }
}
