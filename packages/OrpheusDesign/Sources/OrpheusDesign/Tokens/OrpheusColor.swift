import SwiftUI

/// Theme-aware color tokens — every UI module references colors through
/// this namespace. Each token returns an `OrpheusThemedColor` whose
/// `.resolved` value is a SwiftUI `Color` that picks the right side of
/// the palette at render time.
///
/// `OrpheusColor.Surface.raised.resolved` is the right call site for
/// SwiftUI views; tests and the catalog can also reach the raw dark /
/// light components via `.dark` and `.light`, or via `OrpheusPalette`
/// directly.
public enum OrpheusColor {

    public enum Surface {
        public static let base     = themed(\.surface.base)
        public static let raised   = themed(\.surface.raised)
        public static let elevated = themed(\.surface.elevated)
        public static let overlay  = themed(\.surface.overlay)
    }

    public enum Text {
        public static let primary   = themed(\.text.primary)
        public static let secondary = themed(\.text.secondary)
        public static let tertiary  = themed(\.text.tertiary)
        public static let disabled  = themed(\.text.disabled)
        public static let inverted  = themed(\.text.inverted)
    }

    public enum Border {
        public static let subtle    = themed(\.border.subtle)
        public static let `default` = themed(\.border.default)
        public static let strong    = themed(\.border.strong)
    }

    public enum Accent {
        public static let primary = themed(\.accent.primary)
        public static let hover   = themed(\.accent.hover)
        public static let pressed = themed(\.accent.pressed)
        public static let subtle  = themed(\.accent.subtle)
    }

    public enum Semantic {
        public static let success  = themed(\.semantic.success)
        public static let warning  = themed(\.semantic.warning)
        public static let critical = themed(\.semantic.critical)
        public static let info     = themed(\.semantic.info)
    }

    public enum Glass {
        public static let tint      = themed(\.glass.tint)
        public static let highlight = themed(\.glass.highlight)
    }

    /// Build a themed color by reading the same key path out of the dark
    /// and light palettes — keeps the call site for each token to one
    /// line and ensures dark + light stay paired.
    private static func themed(
        _ keyPath: KeyPath<OrpheusPalette, OrpheusThemedColor.Component>
    ) -> OrpheusThemedColor {
        OrpheusThemedColor(
            dark:  OrpheusPalette.dark[keyPath: keyPath],
            light: OrpheusPalette.light[keyPath: keyPath]
        )
    }
}
