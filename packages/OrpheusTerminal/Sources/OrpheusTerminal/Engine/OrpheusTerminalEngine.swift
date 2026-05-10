import Foundation
import GhosttyTerminal

/// Manages the lifecycle of a `TerminalController` (and the underlying
/// `ghostty_app_t`) for an Orpheus terminal session.
///
/// **Lifecycle:** one engine per process is the effective contract imposed by
/// `ghostty_init`. `OrpheusTerminalEngine` exposes a `shared` singleton that
/// is initialized lazily on first access. Calling `init()` is an alias for
/// accessing `shared` — it does not create a second app.
///
/// **Thread safety:** `@MainActor`-bound. All surface creation and config
/// mutations must happen on the main thread.
@MainActor
public final class OrpheusTerminalEngine {

    // MARK: - Singleton

    /// The process-wide shared engine. Created on first access.
    public static let shared = OrpheusTerminalEngine()

    let controller: TerminalController

    // MARK: - Init

    private init() {
        controller = TerminalController()
        OrpheusTerminalLogger.engine.info("OrpheusTerminalEngine initialized")
    }

    // MARK: - Surface factory

    /// Creates a configured terminal surface backed by a real PTY + shell.
    ///
    /// The returned `OrpheusTerminalSurface` holds the underlying
    /// `AppTerminalView` which renders via Metal. Embed its `view` property
    /// in an `NSView` hierarchy or use the SwiftUI wrapper.
    ///
    /// - Parameter config: shell command, palette, and cwd settings.
    /// - Returns: A ready surface (surface creation happens lazily on first
    ///   `viewDidMoveToWindow`, matching GhosttyTerminal's pattern).
    public func makeSurface(config: SurfaceConfig) throws -> OrpheusTerminalSurface {
        let terminalConfig = buildTerminalConfiguration(from: config)
        let theme = buildTheme(from: config.palette)

        let surfaceController = TerminalController(
            configuration: terminalConfig,
            theme: theme
        )

        let options = buildSurfaceOptions(from: config)
        let surface = OrpheusTerminalSurface(controller: surfaceController, options: options)

        OrpheusTerminalLogger.engine.info("Surface created for command: \(config.resolvedCommand)")
        return surface
    }

    // MARK: - Private helpers

    private func buildTerminalConfiguration(from config: SurfaceConfig) -> TerminalConfiguration {
        let paletteConfig = makeConfiguration(for: config.palette)

        // Inject command via the escape hatch.
        // Ghostty config key: "command" — sets the shell/command to spawn.
        let commandLine = ([config.resolvedCommand] + config.arguments)
            .joined(separator: " ")

        return TerminalConfiguration(
            startingFrom: paletteConfig
        ) { builder in
            builder.withCustom("command", commandLine)
        }
    }

    private func buildTheme(from palette: TerminalPalette) -> TerminalTheme {
        // Phase 2A: dark theme only. Phase 2C will add light + reactive resolution.
        let darkConfig = makeConfiguration(for: palette)
        return TerminalTheme(light: darkConfig, dark: darkConfig)
    }

    private func buildSurfaceOptions(from config: SurfaceConfig) -> TerminalSurfaceOptions {
        var options = TerminalSurfaceOptions(
            backend: .exec,
            workingDirectory: config.cwd?.path
        )
        options.context = .window
        return options
    }
}
