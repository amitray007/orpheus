import AppKit
import SwiftUI

/// One color token, with a value for each theme.
///
/// Tokens carry both the dark and light hex/opacity components so:
/// - components render the right value for the active theme via
///   `resolved`, which threads through `NSColor`'s dynamic provider
///   (so `.preferredColorScheme(.dark)` and the system colorScheme
///   override both work without re-reading the environment in every
///   view);
/// - tests can verify each raw component matches the LOCKED palette
///   without needing a rendering context.
public struct OrpheusThemedColor: Equatable, Sendable {

    /// One half of an `OrpheusThemedColor` — a hex value plus an opacity.
    public struct Component: Equatable, Sendable {
        public let hex: UInt32
        public let opacity: Double

        public init(hex: UInt32, opacity: Double = 1.0) {
            self.hex = hex
            self.opacity = opacity
        }

        public var nsColor: NSColor { NSColor(hex: hex, opacity: opacity) }
        public var color: Color { Color(nsColor: nsColor) }

        /// Linearised relative luminance per WCAG 2.x — used by
        /// `ContrastRatio` to verify text/surface pairings.
        public var relativeLuminance: Double {
            let r = sRGBChannel(Double((hex >> 16) & 0xFF) / 255.0)
            let g = sRGBChannel(Double((hex >>  8) & 0xFF) / 255.0)
            let b = sRGBChannel(Double((hex >>  0) & 0xFF) / 255.0)
            return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }

        private func sRGBChannel(_ c: Double) -> Double {
            c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
    }

    public let dark: Component
    public let light: Component

    public init(dark: Component, light: Component) {
        self.dark = dark
        self.light = light
    }

    public init(dark: UInt32, light: UInt32, opacity: Double = 1.0) {
        self.init(
            dark:  Component(hex: dark,  opacity: opacity),
            light: Component(hex: light, opacity: opacity)
        )
    }

    public init(dark: UInt32, darkOpacity: Double,
                light: UInt32, lightOpacity: Double) {
        self.init(
            dark:  Component(hex: dark,  opacity: darkOpacity),
            light: Component(hex: light, opacity: lightOpacity)
        )
    }

    /// SwiftUI `Color` that resolves to the correct half at render time.
    public var resolved: Color {
        let dark = self.dark
        let light = self.light
        return Color(nsColor: NSColor(name: nil) { appearance in
            appearance.isDarkVariant ? dark.nsColor : light.nsColor
        })
    }

    /// Convenience for tests / catalog: explicitly the dark side.
    public var darkColor: Color { dark.color }
    /// Convenience for tests / catalog: explicitly the light side.
    public var lightColor: Color { light.color }
}

// MARK: - NSColor / NSAppearance helpers (private to the package)

extension NSColor {
    /// Construct from a 24-bit RGB hex value (`0xRRGGBB`) plus an opacity.
    convenience init(hex: UInt32, opacity: Double = 1.0) {
        let r = CGFloat((hex >> 16) & 0xFF) / 255.0
        let g = CGFloat((hex >>  8) & 0xFF) / 255.0
        let b = CGFloat((hex >>  0) & 0xFF) / 255.0
        self.init(srgbRed: r, green: g, blue: b, alpha: CGFloat(opacity))
    }
}

extension NSAppearance {
    /// `true` when the appearance is one of the dark variants. Dynamic
    /// providers receive a non-optional appearance but bestMatch returns
    /// optional, so this wraps the comparison cleanly.
    var isDarkVariant: Bool {
        let darkNames: [NSAppearance.Name] = [
            .darkAqua,
            .vibrantDark,
            .accessibilityHighContrastDarkAqua,
            .accessibilityHighContrastVibrantDark
        ]
        return bestMatch(from: darkNames) != nil
    }
}
