import Foundation

/// Configuration for creating a new terminal surface.
///
/// All fields are optional; defaults produce a login shell in the user's
/// home directory with the Orpheus dark palette.
public struct SurfaceConfig: Sendable {
    /// Command to execute. Defaults to `$SHELL` or `/bin/zsh`.
    public var command: String?

    /// Arguments passed to `command`. Typical shell login flags: `["-i", "-l"]`.
    public var arguments: [String]

    /// Working directory for the spawned process.
    public var cwd: URL?

    /// Additional environment variables to merge into the shell environment.
    /// **Phase 2A limitation:** libghostty currently inherits the parent
    /// process's environment as-is; this field is reserved for the Phase 2C
    /// integration where we'll either route via libghostty's command-line
    /// `env` prefix or extend `TerminalSurfaceOptions` upstream. Setting it
    /// today is a no-op.
    public var environment: [String: String]?

    /// Terminal colour palette applied at surface creation time.
    public var palette: TerminalPalette

    public init(
        command: String? = nil,
        arguments: [String] = ["-i", "-l"],
        cwd: URL? = nil,
        environment: [String: String]? = nil,
        palette: TerminalPalette = .orpheusDefault
    ) {
        self.command = command
        self.arguments = arguments
        self.cwd = cwd
        self.environment = environment
        self.palette = palette
    }

    var resolvedCommand: String {
        command
            ?? ProcessInfo.processInfo.environment["SHELL"]
            ?? "/bin/zsh"
    }
}
