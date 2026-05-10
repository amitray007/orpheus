import Foundation
import OrpheusDesign

/// A terminal color palette expressed as raw RGB+opacity components.
///
/// Built from OrpheusDesign palette tokens (dark side only for now —
/// Phase 2C will wire theme-reactive resolution). All fields carry a
/// non-zero alpha when derived from `orpheusDefault`.
public struct TerminalPalette: Sendable, Equatable {

    /// One resolved RGBA color — hex + opacity, matching `OrpheusThemedColor.Component`.
    public struct RGBA: Sendable, Equatable {
        public let hex: UInt32
        public let opacity: Double

        public init(hex: UInt32, opacity: Double = 1.0) {
            self.hex = hex
            self.opacity = opacity
        }

        /// CSS-style 6-digit hex string for use in libghostty config (e.g. "F5EFE6").
        var hexString: String {
            String(format: "%06X", hex & 0xFFFFFF)
        }
    }

    /// 16-color ANSI palette: indices 0-7 = normal, 8-15 = bright.
    public struct AnsiPalette: Sendable, Equatable {
        public let colors: [RGBA]   // exactly 16 elements

        public init(_ colors: [RGBA]) {
            precondition(colors.count == 16, "AnsiPalette requires exactly 16 colors")
            self.colors = colors
        }
    }

    public let foreground: RGBA
    public let background: RGBA
    public let cursor: RGBA
    public let selection: RGBA
    public let ansi: AnsiPalette

    public init(
        foreground: RGBA,
        background: RGBA,
        cursor: RGBA,
        selection: RGBA,
        ansi: AnsiPalette
    ) {
        self.foreground = foreground
        self.background = background
        self.cursor = cursor
        self.selection = selection
        self.ansi = ansi
    }

    // MARK: - Default Orpheus palette (dark mode, locked v0 tokens)

    /// Hand-curated dark terminal palette derived from OrpheusDesign locked v0 values.
    /// Phase 2C will introduce light-mode and dynamic-theme variants.
    public static let orpheusDefault: TerminalPalette = {
        let dark = OrpheusPalette.dark

        // ANSI 16: normal (0-7) + bright (8-15).
        // Derived from Orpheus semantic + surface tokens; intended to be legible
        // on the dark surface.base (0x16130F) background.
        let ansiColors: [RGBA] = [
            // Normal
            RGBA(hex: 0x1E1A16),          // 0 black   — surface.raised
            RGBA(hex: 0xC96A5F),          // 1 red     — semantic.critical
            RGBA(hex: 0x6FA378),          // 2 green   — semantic.success
            RGBA(hex: 0xD89E5C),          // 3 yellow  — semantic.warning
            RGBA(hex: 0x7899B0),          // 4 blue    — semantic.info
            RGBA(hex: 0xD9A441),          // 5 magenta — accent.primary
            RGBA(hex: 0x7899B0),          // 6 cyan    — semantic.info (same as blue; terminal convention)
            RGBA(hex: 0xA89F92),          // 7 white   — text.secondary
            // Bright
            RGBA(hex: 0x4A453F),          // 8  bright black  — text.disabled
            RGBA(hex: 0xE07A6F),          // 9  bright red
            RGBA(hex: 0x85BB8E),          // 10 bright green
            RGBA(hex: 0xE6B04E),          // 11 bright yellow — accent.hover
            RGBA(hex: 0x92AEC6),          // 12 bright blue
            RGBA(hex: 0xE6B04E),          // 13 bright magenta
            RGBA(hex: 0x92AEC6),          // 14 bright cyan
            RGBA(hex: 0xF5EFE6),          // 15 bright white — text.primary
        ]

        return TerminalPalette(
            foreground: RGBA(hex: dark.text.primary.hex),
            background: RGBA(hex: dark.surface.base.hex),
            cursor:     RGBA(hex: dark.accent.primary.hex),
            selection:  RGBA(hex: dark.surface.elevated.hex, opacity: 0.7),
            ansi:       AnsiPalette(ansiColors)
        )
    }()
}
