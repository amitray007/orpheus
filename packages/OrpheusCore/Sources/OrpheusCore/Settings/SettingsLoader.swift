import Foundation

/// Loads and writes `OrpheusSettings` JSON files.
///
/// `loadGlobal` and `loadProject` are intentionally separate methods even
/// though they share an implementation today; this lets future divergence
/// (e.g. per-tier validation) happen without a breaking API change.
///
/// ## Atomic writes
/// `write(_:to:)` uses the write-temp-then-rename pattern so that a crash
/// mid-write never leaves a partially-written config file.
public struct SettingsLoader: Sendable {

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .prettyPrinted]
        return e
    }()

    private static let decoder = JSONDecoder()

    public init() {}

    // MARK: - Load

    /// Load the global settings file at `url`.
    ///
    /// - Returns: `OrpheusSettings.defaultValue` if the file does not exist.
    /// - Throws: `OrpheusCoreError.persistenceFailed` if the file exists but
    ///   cannot be decoded.
    public func loadGlobal(from url: URL) throws -> OrpheusSettings {
        try load(from: url)
    }

    /// Load a per-project settings file at `url`.
    ///
    /// - Returns: `OrpheusSettings.defaultValue` if the file does not exist.
    /// - Throws: `OrpheusCoreError.persistenceFailed` if the file exists but
    ///   cannot be decoded.
    public func loadProject(from url: URL) throws -> OrpheusSettings {
        try load(from: url)
    }

    // MARK: - Write

    /// Atomically write `settings` as JSON to `url`.
    ///
    /// Creates any missing intermediate directories first.
    /// Uses write-temp-then-rename so a crash mid-write never corrupts the
    /// target file.
    ///
    /// - Throws: `OrpheusCoreError.persistenceFailed` on any I/O failure.
    public func write(_ settings: OrpheusSettings, to url: URL) throws {
        let data: Data
        do {
            data = try Self.encoder.encode(settings)
        } catch {
            throw OrpheusCoreError.persistenceFailed(
                reason: "settings encode failed: \(error)"
            )
        }

        let dir = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: dir,
                withIntermediateDirectories: true
            )
        } catch {
            throw OrpheusCoreError.persistenceFailed(
                reason: "settings directory creation failed: \(error)"
            )
        }

        let tmpURL = dir.appendingPathComponent(
            ".\(url.lastPathComponent).tmp"
        )

        do {
            try data.write(to: tmpURL, options: .atomic)
        } catch {
            throw OrpheusCoreError.persistenceFailed(
                reason: "settings temp write failed: \(error)"
            )
        }

        do {
            // replaceItemAt performs an atomic rename under the hood.
            _ = try FileManager.default.replaceItemAt(
                url,
                withItemAt: tmpURL,
                backupItemName: nil,
                options: []
            )
        } catch {
            // If the target doesn't yet exist, replaceItemAt will error;
            // fall back to a POSIX rename which handles new-file creation.
            let fm = FileManager.default
            if !fm.fileExists(atPath: url.path) {
                do {
                    try fm.moveItem(at: tmpURL, to: url)
                } catch {
                    throw OrpheusCoreError.persistenceFailed(
                        reason: "settings rename failed: \(error)"
                    )
                }
            } else {
                throw OrpheusCoreError.persistenceFailed(
                    reason: "settings atomic replace failed: \(error)"
                )
            }
        }
    }

    // MARK: - Private

    private func load(from url: URL) throws -> OrpheusSettings {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return .defaultValue
        }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw OrpheusCoreError.persistenceFailed(
                reason: "settings read failed: \(error)"
            )
        }
        do {
            return try Self.decoder.decode(OrpheusSettings.self, from: data)
        } catch {
            throw OrpheusCoreError.persistenceFailed(
                reason: "settings decode failed: \(error)"
            )
        }
    }
}
