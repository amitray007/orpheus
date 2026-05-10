import XCTest
@testable import OrpheusCore

final class ClaudeBinaryResolverTests: XCTestCase {

    // MARK: - Override: valid executable

    func testOverrideReturnsPathWhenExecutable() async throws {
        let resolver = ClaudeBinaryResolver()
        // /bin/echo is always present and executable on macOS.
        let path = try await resolver.resolve(override: "/bin/echo")
        XCTAssertEqual(path, "/bin/echo")
    }

    // MARK: - Override: non-existent path throws

    func testOverrideThrowsWhenNotFound() async {
        let resolver = ClaudeBinaryResolver()
        do {
            _ = try await resolver.resolve(override: "/tmp/this-binary-does-not-exist-orpheus")
            XCTFail("Expected an error to be thrown")
        } catch let error as OrpheusCoreError {
            if case .subprocessSpawn(let reason) = error {
                XCTAssertTrue(reason.contains("not found or not executable"), "Unexpected reason: \(reason)")
            } else {
                XCTFail("Wrong error case: \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - PATH search: find /bin/echo via $PATH

    func testFindsBinaryViaPath() async throws {
        let resolver = ClaudeBinaryResolver()
        // Create a temp directory with a shell script named "claude" that is executable.
        let tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("ClaudeBinaryResolverTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        // Write a minimal shell script — just `#!/bin/sh\n` — as "claude".
        let fakeClaude = tmpDir.appendingPathComponent("claude")
        let script = "#!/bin/sh\n"
        try script.write(to: fakeClaude, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755 as NSNumber],
            ofItemAtPath: fakeClaude.path
        )

        // Prepend our temp dir to PATH.
        let originalPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
        setenv("PATH", "\(tmpDir.path):\(originalPath)", 1)
        defer { setenv("PATH", originalPath, 1) }

        let resolved = try await resolver.resolve()
        XCTAssertEqual(resolved, fakeClaude.path)
    }

    // MARK: - PATH search: not found throws with helpful message

    func testThrowsWhenNotInPath() async throws {
        let resolver = ClaudeBinaryResolver()

        // Temporarily set PATH to a directory that certainly has no "claude".
        let tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("ClaudeBinaryResolverEmpty-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let originalPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
        setenv("PATH", tmpDir.path, 1)
        defer { setenv("PATH", originalPath, 1) }

        do {
            _ = try await resolver.resolve()
            XCTFail("Expected an error to be thrown")
        } catch let error as OrpheusCoreError {
            if case .subprocessSpawn(let reason) = error {
                XCTAssertTrue(reason.contains("not found in PATH"), "Unexpected reason: \(reason)")
            } else {
                XCTFail("Wrong error case: \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }
}
