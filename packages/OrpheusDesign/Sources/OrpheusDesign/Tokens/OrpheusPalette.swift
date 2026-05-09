import Foundation

/// The full LOCKED v0 palette as a structured tree. Components consume
/// `OrpheusColor` (which exposes per-token `OrpheusThemedColor` values
/// resolving to the active theme); `OrpheusPalette` is the underlying
/// data — surfaced publicly so tests, the catalog, and tooling can
/// introspect a single palette without going through theme resolution.
///
/// Source of truth: `extras/specs/design-principles.md` — "LOCKED v0
/// dark-mode starter values" and "LOCKED v0 light-mode starter values".
public struct OrpheusPalette: Sendable {

    public typealias C = OrpheusThemedColor.Component

    public struct Surfaces: Sendable {
        public let base:     C
        public let raised:   C
        public let elevated: C
        public let overlay:  C
    }

    public struct Texts: Sendable {
        public let primary:   C
        public let secondary: C
        public let tertiary:  C
        public let disabled:  C
        public let inverted:  C
    }

    public struct Borders: Sendable {
        public let subtle:  C
        // `default` is a Swift keyword; back-tick to keep the spec name.
        public let `default`: C
        public let strong:  C
    }

    public struct Accents: Sendable {
        public let primary: C
        public let hover:   C
        public let pressed: C
        public let subtle:  C
    }

    public struct Semantics: Sendable {
        public let success:  C
        public let warning:  C
        public let critical: C
        public let info:     C
    }

    public struct Glass: Sendable {
        public let tint:      C
        public let highlight: C
    }

    public let surface:  Surfaces
    public let text:     Texts
    public let border:   Borders
    public let accent:   Accents
    public let semantic: Semantics
    public let glass:    Glass

    // MARK: - LOCKED v0 dark palette

    public static let dark = OrpheusPalette(
        surface: Surfaces(
            base:     C(hex: 0x16130F),
            raised:   C(hex: 0x1E1A16),
            elevated: C(hex: 0x28231D),
            overlay:  C(hex: 0x332D26)
        ),
        text: Texts(
            primary:   C(hex: 0xF5EFE6),
            secondary: C(hex: 0xA89F92),
            tertiary:  C(hex: 0x6B6358),
            disabled:  C(hex: 0x4A453F),
            inverted:  C(hex: 0x1A1814)
        ),
        border: Borders(
            subtle:    C(hex: 0x2C2723),
            default:   C(hex: 0x3A352E),
            strong:    C(hex: 0x4D4741)
        ),
        accent: Accents(
            primary: C(hex: 0xD9A441),
            hover:   C(hex: 0xE6B04E),
            pressed: C(hex: 0xBE8F35),
            subtle:  C(hex: 0xD9A441, opacity: 0.12)
        ),
        semantic: Semantics(
            success:  C(hex: 0x6FA378),
            warning:  C(hex: 0xD89E5C),
            critical: C(hex: 0xC96A5F),
            info:     C(hex: 0x7899B0)
        ),
        glass: Glass(
            tint:      C(hex: 0x241F1A, opacity: 0.50),
            highlight: C(hex: 0xFFFFFF, opacity: 0.06)
        )
    )

    // MARK: - LOCKED v0 light palette

    public static let light = OrpheusPalette(
        surface: Surfaces(
            base:     C(hex: 0xFAF7F2),
            raised:   C(hex: 0xF2ECE3),
            elevated: C(hex: 0xE8DFD2),
            overlay:  C(hex: 0xD9CFC0)
        ),
        text: Texts(
            primary:   C(hex: 0x1A1815),
            secondary: C(hex: 0x5C554B),
            tertiary:  C(hex: 0x8A8175),
            disabled:  C(hex: 0xB0A899),
            inverted:  C(hex: 0xFAF7F2)
        ),
        border: Borders(
            subtle:    C(hex: 0xE5DED1),
            default:   C(hex: 0xCFC5B3),
            strong:    C(hex: 0xA89F8B)
        ),
        accent: Accents(
            primary: C(hex: 0xB88A2E),
            hover:   C(hex: 0xC99937),
            pressed: C(hex: 0x9E7625),
            subtle:  C(hex: 0xB88A2E, opacity: 0.10)
        ),
        semantic: Semantics(
            success:  C(hex: 0x4A7A56),
            warning:  C(hex: 0xB57A2D),
            critical: C(hex: 0xA04A3F),
            info:     C(hex: 0x4C7590)
        ),
        glass: Glass(
            tint:      C(hex: 0xF2ECE3, opacity: 0.60),
            highlight: C(hex: 0xFFFFFF, opacity: 0.40)
        )
    )
}
