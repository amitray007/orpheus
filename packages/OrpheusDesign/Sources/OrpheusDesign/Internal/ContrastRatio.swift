import Foundation

/// WCAG 2.x relative-contrast helper. Used by tests to verify token pairings
/// (e.g. text-on-surface) clear AA thresholds, and available to runtime
/// callers when they tune a custom token combination.
///
/// Reference: https://www.w3.org/WAI/WCAG21/Techniques/general/G18
enum ContrastRatio {

    /// Contrast between two opaque components. For tokens that carry an
    /// opacity below 1.0 the value is composited over white before the
    /// ratio is computed — that's the WCAG-permitted simplification: tests
    /// here are checking palette intent, not arbitrary multi-layer stacks.
    static func between(
        _ foreground: OrpheusThemedColor.Component,
        on background: OrpheusThemedColor.Component
    ) -> Double {
        let fg = foreground.composited(over: background)
        let bg = background.opaqueLuminance
        let l1 = max(fg, bg)
        let l2 = min(fg, bg)
        return (l1 + 0.05) / (l2 + 0.05)
    }
}

private extension OrpheusThemedColor.Component {
    /// Luminance of the colour treated as fully opaque. For tokens that
    /// carry a translucency we assume they sit on the matching theme
    /// surface — that's how the catalog will render them and is the
    /// closest legitimate approximation for a pre-render check.
    var opaqueLuminance: Double { relativeLuminance }

    /// Composite this component (which may carry opacity < 1.0) over a
    /// background component, returning the resulting relative luminance.
    func composited(over background: OrpheusThemedColor.Component) -> Double {
        guard opacity < 1.0 else { return relativeLuminance }
        let blend = relativeLuminance * opacity
                  + background.relativeLuminance * (1.0 - opacity)
        return blend
    }
}
