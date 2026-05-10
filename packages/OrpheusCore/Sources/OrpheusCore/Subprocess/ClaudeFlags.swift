import Foundation

// MARK: - OutputFormat

/// The output format requested from `claude`.
public enum OutputFormat: String, Sendable, Equatable {
    case streamJson = "stream-json"
    case text = "text"
}

// MARK: - ClaudeFlags

/// A declarative builder for `claude` CLI flags.
///
/// Usage:
/// ```swift
/// var flags = ClaudeFlags()
/// flags.mode = .resume(sessionID)
/// flags.outputFormat = .streamJson
/// let argv = flags.build()   // ["--resume", "<id>", "--output-format", "stream-json"]
/// ```
public struct ClaudeFlags: Sendable, Equatable {

    // MARK: Mode

    /// Controls session continuity.
    public enum Mode: Sendable, Equatable {
        /// Start a brand-new session (no --session-id / --resume flag).
        case fresh

        /// Resume an existing session: `--resume <id>`.
        case resume(SessionID)

        /// Fork from an existing session: `--resume <id> --fork-session`.
        case fork(SessionID)
    }

    // MARK: Properties

    /// Session mode. Defaults to `.fresh`.
    public var mode: Mode = .fresh

    /// Append `--bare` to the argv. Suppresses the interactive UI.
    public var bare: Bool = false

    /// Append `--output-format <value>` to the argv.
    public var outputFormat: OutputFormat? = nil

    /// Any additional flags appended verbatim at the end.
    public var extraArgs: [String] = []

    // MARK: Lifecycle

    public init() {}

    // MARK: Build

    /// Produce the argv array for `claude`.
    ///
    /// Flag ordering:
    /// 1. `--resume <id>` (if mode is .resume or .fork)
    /// 2. `--fork-session` (if mode is .fork)
    /// 3. `--output-format <value>` (if set)
    /// 4. `--bare` (if set)
    /// 5. `extraArgs` (verbatim)
    public func build() -> [String] {
        var args: [String] = []

        switch mode {
        case .fresh:
            break
        case .resume(let sid):
            args += ["--resume", sid.rawValue]
        case .fork(let sid):
            args += ["--resume", sid.rawValue, "--fork-session"]
        }

        if let format = outputFormat {
            args += ["--output-format", format.rawValue]
        }

        if bare {
            args.append("--bare")
        }

        args += extraArgs

        return args
    }
}
