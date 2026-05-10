import AppKit
import SwiftUI
import GhosttyTerminal

/// SwiftUI wrapper for `OrpheusTerminalNSView`.
///
/// The surface is created externally (via `OrpheusTerminalEngine.shared.makeSurface(...)`)
/// and injected — the view does not own the engine. Resize is handled by
/// AppTerminalView's `setFrameSize` / `layout` overrides.
///
/// Usage:
/// ```swift
/// let surface = try await OrpheusTerminalEngine.shared.makeSurface(config: .init())
/// OrpheusTerminalView(surface: surface)
/// ```
public struct OrpheusTerminalView: NSViewRepresentable {

    public let surface: OrpheusTerminalSurface

    public init(surface: OrpheusTerminalSurface) {
        self.surface = surface
    }

    public func makeNSView(context: Context) -> OrpheusTerminalNSView {
        OrpheusTerminalNSView(surface: surface)
    }

    public func updateNSView(_ nsView: OrpheusTerminalNSView, context: Context) {
        // Resize is handled by AppTerminalView's layout overrides; no update needed.
    }
}
