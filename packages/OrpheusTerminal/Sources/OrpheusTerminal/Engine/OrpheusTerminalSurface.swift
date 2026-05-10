import AppKit
import GhosttyTerminal

/// A live terminal surface: a `TerminalController` + `AppTerminalView`
/// configured for Orpheus, ready to be embedded in an NSView hierarchy.
///
/// The underlying `AppTerminalView` owns the `CAMetalLayer`, the PTY, and the
/// child-process lifecycle. `OrpheusTerminalSurface` is a thin, Orpheus-owned
/// wrapper that hides the GhosttyTerminal types from the public API.
///
/// **Thread safety:** `@MainActor`. All access must be on the main thread.
/// The `view` property should be embedded only after `makeNSView` is called
/// (the surface is created on first `viewDidMoveToWindow`).
@MainActor
public final class OrpheusTerminalSurface {

    let controller: TerminalController
    let options: TerminalSurfaceOptions

    /// The AppKit view that hosts the Metal-backed terminal surface.
    /// Embed this in your NSView hierarchy.
    public let view: AppTerminalView

    // MARK: - Init

    init(controller: TerminalController, options: TerminalSurfaceOptions) {
        self.controller = controller
        self.options = options

        let v = AppTerminalView(frame: .zero)
        v.controller = controller
        v.configuration = options
        self.view = v

        OrpheusTerminalLogger.surface.info("OrpheusTerminalSurface created")
    }

    // MARK: - Public surface

    /// Notify the surface that the containing view has been resized.
    /// Normally handled automatically by AppTerminalView's layout overrides;
    /// call this if you bypass AppKit's layout system.
    public func resize(to size: NSSize) {
        view.setFrameSize(size)
        OrpheusTerminalLogger.surface.debug("resize to \(size.width)x\(size.height)")
    }

    /// Cleanly close the terminal surface and terminate the child process.
    ///
    /// Detaches the controller from the view which triggers `tearDownSurface`
    /// inside `TerminalSurfaceCoordinator`, sending SIGHUP to the child
    /// process and freeing the Metal layer. After `close()`, do not interact
    /// with `view` again.
    public func close() {
        // Removing the controller causes TerminalSurfaceCoordinator.rebuildIfReady
        // to call tearDownSurface, which frees the TerminalSurface and disconnects
        // the PTY — this is the correct public teardown path.
        view.controller = nil
        OrpheusTerminalLogger.surface.info("OrpheusTerminalSurface closed")
    }
}
