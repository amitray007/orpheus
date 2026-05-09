import AppKit
import SwiftUI

/// SwiftUI background view for an `OrpheusMaterial.Spec`. Wraps an
/// `NSVisualEffectView` (which provides the blur), composites the spec's
/// tint on top, applies the saturation boost, and draws the rim.
///
/// The exposed surface is a single `View`; the `NSViewRepresentable`
/// underneath is an implementation detail that consumers shouldn't see.
public struct OrpheusMaterialBackground: View {
    private let spec: OrpheusMaterial.Spec
    @Environment(\.colorScheme) private var colorScheme

    public init(_ spec: OrpheusMaterial.Spec) {
        self.spec = spec
    }

    public var body: some View {
        ZStack {
            VisualEffectBacking(spec: spec)
            spec.tint.resolved
                .blendMode(.normal)
        }
        .overlay(rim)
        .clipShape(Rectangle())
    }

    @ViewBuilder
    private var rim: some View {
        switch spec.rim {
        case .none:
            EmptyView()
        case .full(let width):
            // glass.highlight is the same hex (#FFFFFF) in both palettes;
            // its opacity changes between themes.
            OrpheusColor.Glass.highlight.resolved
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .mask(
                    Rectangle()
                        .strokeBorder(.black, lineWidth: width)
                )
        case .bottomEdge(let width):
            VStack {
                Spacer(minLength: 0)
                OrpheusColor.Glass.highlight.resolved
                    .frame(height: width)
            }
        }
    }
}

/// View modifier — usage: `myView.orpheusMaterial(.sidebar)`.
public extension View {
    func orpheusMaterial(_ spec: OrpheusMaterial.Spec) -> some View {
        background(OrpheusMaterialBackground(spec))
    }
}

// MARK: - AppKit backing

private struct VisualEffectBacking: NSViewRepresentable {
    let spec: OrpheusMaterial.Spec

    func makeNSView(context: Context) -> SaturatingVisualEffectView {
        let view = SaturatingVisualEffectView()
        view.material = spec.approximateMaterial.nsMaterial
        view.blendingMode = .behindWindow
        view.state = .active
        view.saturationBoost = spec.saturationBoost
        return view
    }

    func updateNSView(_ view: SaturatingVisualEffectView, context: Context) {
        view.material = spec.approximateMaterial.nsMaterial
        view.saturationBoost = spec.saturationBoost
    }
}

/// Adds a saturation-boost CIFilter on top of `NSVisualEffectView`'s blur.
/// The filter sits on the layer's `compositingFilter` chain so it acts on
/// content rendered behind the view.
private final class SaturatingVisualEffectView: NSVisualEffectView {

    var saturationBoost: Double = 1.0 {
        didSet {
            guard saturationBoost != oldValue else { return }
            applySaturation()
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        wantsLayer = true
        applySaturation()
    }

    private func applySaturation() {
        guard saturationBoost != 1.0,
              let layer = layer
        else {
            layer?.backgroundFilters = []
            return
        }
        let filter = CIFilter(name: "CIColorControls",
                              parameters: ["inputSaturation": saturationBoost])
        layer.backgroundFilters = filter.map { [$0] } ?? []
    }
}
