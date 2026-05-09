import AppKit
import SwiftUI

/// Custom-tuned materials layered on macOS Liquid Glass.
///
/// LOCKED in `extras/specs/design-principles.md`:
///
/// | Token   | Blur (pt) | Tint dark / light | Saturation | Rim                       |
/// |---------|-----------|-------------------|------------|---------------------------|
/// | sidebar | 20        | 50% / 60%         | 120%       | none                      |
/// | palette | 40        | 70% / 75%         | 115%       | full, glass.highlight 1.5pt |
/// | toolbar | 15        | 40% / 50%         | 110%       | bottom, glass.highlight 1pt |
/// | overlay | 30        | 65% / 70%         | 115%       | full, glass.highlight 1pt   |
///
/// The material renderer uses `NSVisualEffectView` for the actual blur
/// (its blur radius isn't user-tunable, so each spec maps to the closest
/// system material preset) and layers a tinted, saturation-boosted
/// rectangle over it. The blur-radius numbers in the spec function as a
/// design ladder and as a target for any future custom-blur work.
public enum OrpheusMaterial {

    public struct Spec: Sendable, Equatable {
        public let name: String
        public let blurRadius: CGFloat            // design intent — see note above
        public let tint: OrpheusThemedColor       // composited over the blur
        public let saturationBoost: Double        // 1.0 = neutral, 1.2 = +20%
        public let rim: Rim
        public let approximateMaterial: ApproximateMaterial

        public init(
            name: String,
            blurRadius: CGFloat,
            tint: OrpheusThemedColor,
            saturationBoost: Double,
            rim: Rim,
            approximateMaterial: ApproximateMaterial
        ) {
            self.name = name
            self.blurRadius = blurRadius
            self.tint = tint
            self.saturationBoost = saturationBoost
            self.rim = rim
            self.approximateMaterial = approximateMaterial
        }
    }

    /// Rim-light specification — kept theme-aware so the highlight
    /// changes weight between dark and light surfaces (per the LOCKED
    /// `glass.highlight` token).
    public enum Rim: Sendable, Equatable {
        case none
        case full(width: CGFloat)
        case bottomEdge(width: CGFloat)
    }

    /// Sendable wrapper around `NSVisualEffectView.Material` so token
    /// definitions can stay in pure-data files. Mapped to the actual
    /// `NSVisualEffectView.Material` at apply time.
    public enum ApproximateMaterial: Sendable, Equatable {
        case titlebar       // lightest preset — paired with toolbar (15pt)
        case sidebar        // moderate — paired with sidebar (20pt)
        case menu           // heavier — paired with overlay (30pt)
        case hudWindow      // heaviest — paired with palette (40pt)

        var nsMaterial: NSVisualEffectView.Material {
            switch self {
            case .titlebar:  return .titlebar
            case .sidebar:   return .sidebar
            case .menu:      return .menu
            case .hudWindow: return .hudWindow
            }
        }
    }

    // MARK: - LOCKED v0 specs

    public static let sidebar = Spec(
        name: "sidebar",
        blurRadius: 20,
        tint: OrpheusThemedColor(
            dark:  0x241F1A, darkOpacity:  0.50,
            light: 0xF2ECE3, lightOpacity: 0.60
        ),
        saturationBoost: 1.20,
        rim: .none,
        approximateMaterial: .sidebar
    )

    public static let palette = Spec(
        name: "palette",
        blurRadius: 40,
        tint: OrpheusThemedColor(
            dark:  0x241F1A, darkOpacity:  0.70,
            light: 0xF2ECE3, lightOpacity: 0.75
        ),
        saturationBoost: 1.15,
        rim: .full(width: 1.5),
        approximateMaterial: .hudWindow
    )

    public static let toolbar = Spec(
        name: "toolbar",
        blurRadius: 15,
        tint: OrpheusThemedColor(
            dark:  0x241F1A, darkOpacity:  0.40,
            light: 0xF2ECE3, lightOpacity: 0.50
        ),
        saturationBoost: 1.10,
        rim: .bottomEdge(width: 1),
        approximateMaterial: .titlebar
    )

    public static let overlay = Spec(
        name: "overlay",
        blurRadius: 30,
        tint: OrpheusThemedColor(
            dark:  0x241F1A, darkOpacity:  0.65,
            light: 0xF2ECE3, lightOpacity: 0.70
        ),
        saturationBoost: 1.15,
        rim: .full(width: 1),
        approximateMaterial: .menu
    )

    public static let all: [Spec] = [sidebar, palette, toolbar, overlay]
}
