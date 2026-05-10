import Foundation

/// Resolves the path to the Orpheus SQLite database.
///
/// Priority:
/// 1. `--orpheus-db-path <path>` CLI argument
/// 2. `ORPHEUS_DB_PATH` environment variable
/// 3. Default: `~/.orpheus/orpheus.db`
///
/// Never hardcodes `/Users/` — always uses `FileManager` APIs.
enum DBLocator {
    static func resolve() -> String {
        // 1. CLI argument override
        let args = CommandLine.arguments
        if let idx = args.firstIndex(of: "--orpheus-db-path"),
           idx + 1 < args.count {
            return args[idx + 1]
        }

        // 2. Environment variable override
        if let envPath = ProcessInfo.processInfo.environment["ORPHEUS_DB_PATH"],
           !envPath.isEmpty {
            return envPath
        }

        // 3. Default location
        let home = FileManager.default.homeDirectoryForCurrentUser
        let dir = home.appendingPathComponent(".orpheus", isDirectory: true)
        return dir.appendingPathComponent("orpheus.db").path
    }

    /// Ensures the parent directory exists, creating it if needed.
    static func ensureDirectoryExists(for dbPath: String) throws {
        let dir = URL(fileURLWithPath: dbPath).deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true,
            attributes: nil
        )
    }
}
