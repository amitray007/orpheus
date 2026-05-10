import Foundation

/// Resolves the path to the `claude` binary on the current system.
///
/// Resolution order:
/// 1. Explicit override (if provided and executable).
/// 2. `$PATH`-based search — each directory is checked for an executable `claude`.
/// 3. Throws `OrpheusCoreError.subprocessSpawn` if not found.
///
/// Never hardcodes any specific installation path.
public struct ClaudeBinaryResolver: Sendable {

    public init() {}

    /// Resolve the path to the `claude` binary.
    ///
    /// - Parameter override: An explicit absolute path. If supplied and the
    ///   file exists with execute permission, it is returned immediately.
    /// - Returns: Absolute path to the `claude` binary.
    /// - Throws: `OrpheusCoreError.subprocessSpawn` if not found.
    public func resolve(override: String? = nil) async throws -> String {
        // 1. Explicit override takes priority.
        if let path = override {
            if isExecutable(path) {
                return path
            }
            throw OrpheusCoreError.subprocessSpawn(
                reason: "claude binary override '\(path)' not found or not executable"
            )
        }

        // 2. Search PATH.
        let pathEnv = ProcessInfo.processInfo.environment["PATH"] ?? ""
        let directories = pathEnv.split(separator: ":", omittingEmptySubsequences: true)
            .map(String.init)

        for dir in directories {
            let candidate = dir.hasSuffix("/")
                ? "\(dir)claude"
                : "\(dir)/claude"
            if isExecutable(candidate) {
                return candidate
            }
        }

        // 3. Not found.
        throw OrpheusCoreError.subprocessSpawn(
            reason: "claude not found in PATH; set claude.binaryPath in settings"
        )
    }

    // MARK: - Private

    private func isExecutable(_ path: String) -> Bool {
        FileManager.default.isExecutableFile(atPath: path)
    }
}
