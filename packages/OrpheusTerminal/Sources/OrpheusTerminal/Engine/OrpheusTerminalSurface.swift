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
    ///
    /// Phase 2C note: this exposes `GhosttyTerminal.AppTerminalView` directly,
    /// which is a deliberate trade — keeping a thin wrapper means callers
    /// occasionally need a GhosttyTerminal type. Use `surface.view.layer`
    /// for the `CAMetalLayer`, `surface.view.delegate` to subscribe to
    /// `TerminalSurfaceCloseDelegate.terminalDidClose(processAlive:)` for
    /// process-exit notifications. See AUDIT.md §6.
    public let view: AppTerminalView

    /// Whether `close()` has been called. Used to assert correct cleanup at
    /// deinit time. Public so Phase 2C can check before re-entering teardown.
    /// `nonisolated(unsafe)` because deinit runs off-actor and needs to read
    /// this; in practice `close()` runs on @MainActor and is the only writer,
    /// and the close-then-release ordering rules out concurrent access.
    public nonisolated(unsafe) private(set) var isClosed: Bool = false

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

    deinit {
        assert(isClosed, "OrpheusTerminalSurface deinit'd without close() — Metal layer + PTY torn down without notice. Phase 2C consumers must call close() before releasing the surface.")
    }

    // MARK: - Public surface

    /// Notify the surface that the containing view has been resized.
    /// Normally handled automatically by AppTerminalView's layout overrides;
    /// call this if you bypass AppKit's layout system.
    public func resize(to size: NSSize) {
        view.setFrameSize(size)
        OrpheusTerminalLogger.surface.debug("resize to \(size.width)x\(size.height)")
    }

    /// Convenience overload accepting integer cell-pixel dimensions.
    public func resize(width: Int, height: Int) {
        resize(to: NSSize(width: width, height: height))
    }

    /// Send text directly into the terminal as if the user typed it.
    /// Thin pass-through to `view.sendText` — exposed at the surface level
    /// so Phase 2C consumers don't need to reach through to GhosttyTerminal.
    public func sendText(_ text: String) {
        view.sendText(text)
    }

    /// Cleanly close the terminal surface and terminate the child process.
    ///
    /// Detaches the controller from the view which triggers `tearDownSurface`
    /// inside `TerminalSurfaceCoordinator`, sending SIGHUP to the child
    /// process and freeing the Metal layer. After `close()`, do not interact
    /// with `view` again. Idempotent — calling close() twice is a no-op.
    public func close() {
        guard !isClosed else { return }
        // Removing the controller causes TerminalSurfaceCoordinator.rebuildIfReady
        // to call tearDownSurface, which frees the TerminalSurface and disconnects
        // the PTY — this is the correct public teardown path.
        view.controller = nil
        isClosed = true
        OrpheusTerminalLogger.surface.info("OrpheusTerminalSurface closed")
    }
}
