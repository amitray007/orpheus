import AppKit
import CoreGraphics
import SwiftUI

/// 6-step type ramp. Every text rendered in Orpheus goes through one of
/// these tokens — never `Font.system(size:)` directly in user-facing code.
///
/// LOCKED in `extras/specs/design-principles.md`:
///
/// | Token   | Size / Line height | Weight    | Use                            |
/// |---------|--------------------|-----------|--------------------------------|
/// | display | 32 / 40            | semibold  | hero / large hero dashboards   |
/// | title   | 22 / 28            | semibold  | section titles                 |
/// | heading | 17 / 24            | semibold  | sub-section titles, rows       |
/// | body    | 13 / 18            | regular   | default UI text                |
/// | caption | 11 / 14            | medium    | metadata, badges               |
/// | mono    | 13 / 18            | regular   | code, terminal                 |
///
/// Branded faces: **Satoshi** (sans, all UI chrome) and **Commit Mono**
/// (mono). The package ships with the registration plumbing but not the
/// font binaries — see `Resources/Fonts/README.md`. When binaries are
/// absent the tokens fall back to the system sans + system monospaced
/// faces with matching size and weight, so layouts render identically in
/// shape and the catalog stays usable without licensed assets.
public enum OrpheusTypography {

    /// One row of the ramp.
    public struct Style: Sendable, Equatable {
        public let kind: Kind
        public let size: CGFloat
        public let lineHeight: CGFloat
        public let weight: Font.Weight
        public let nsWeight: NSFont.Weight
        public let tracking: CGFloat

        public enum Kind: Sendable, Equatable { case sans, mono }

        /// SwiftUI font for this style. Picks the branded face if it's
        /// available at runtime, otherwise the closest system face.
        public var font: Font {
            switch kind {
            case .sans:
                let postScript = Self.satoshiPostScript(for: weight)
                if FontRegistry.shared.isPostScriptNameAvailable(postScript) {
                    return Font.custom(postScript, size: size)
                }
                if FontRegistry.shared.isFamilyAvailable("Satoshi") {
                    return Font.custom("Satoshi", size: size).weight(weight)
                }
                return Font.system(size: size, weight: weight, design: .default)
            case .mono:
                let postScript = "CommitMono-\(Self.commitMonoSuffix(for: weight))"
                if FontRegistry.shared.isPostScriptNameAvailable(postScript) {
                    return Font.custom(postScript, size: size)
                }
                if FontRegistry.shared.isFamilyAvailable("Commit Mono") {
                    return Font.custom("Commit Mono", size: size).weight(weight)
                }
                return Font.system(size: size, weight: weight, design: .monospaced)
            }
        }

        /// Equivalent `NSFont` for AppKit-backed components (text views,
        /// custom drawing). Kept in sync with the SwiftUI `font` above.
        public var nsFont: NSFont {
            switch kind {
            case .sans:
                let postScript = Self.satoshiPostScript(for: weight)
                if let font = NSFont(name: postScript, size: size) { return font }
                if let font = NSFont(name: "Satoshi", size: size) { return font }
                return NSFont.systemFont(ofSize: size, weight: nsWeight)
            case .mono:
                let postScript = "CommitMono-\(Self.commitMonoSuffix(for: weight))"
                if let font = NSFont(name: postScript, size: size) { return font }
                if let font = NSFont(name: "Commit Mono", size: size) { return font }
                return NSFont.monospacedSystemFont(ofSize: size, weight: nsWeight)
            }
        }

        /// Extra space SwiftUI needs to add between lines so the
        /// rendered line-box matches the spec's `lineHeight`.
        public var lineSpacing: CGFloat { max(0, lineHeight - size) }

        // Satoshi face naming — Indian Type Foundry / Fontshare ship the
        // family as Satoshi-{Light, Regular, Medium, Bold, Black}. Variable
        // builds also exist; we prefer static faces for predictability.
        private static func satoshiPostScript(for weight: Font.Weight) -> String {
            switch weight {
            case .light, .ultraLight, .thin: return "Satoshi-Light"
            case .medium:                    return "Satoshi-Medium"
            case .semibold, .bold:           return "Satoshi-Bold"
            case .heavy, .black:             return "Satoshi-Black"
            default:                         return "Satoshi-Regular"
            }
        }

        // Commit Mono face naming — eigilnikolajsen ships the family as
        // CommitMono-{Light, Regular, Medium, Bold} plus italics.
        private static func commitMonoSuffix(for weight: Font.Weight) -> String {
            switch weight {
            case .light, .ultraLight, .thin: return "Light"
            case .medium:                    return "Medium"
            case .semibold, .bold:           return "Bold"
            default:                         return "Regular"
            }
        }
    }

    public static let display = Style(
        kind: .sans, size: 32, lineHeight: 40,
        weight: .semibold, nsWeight: .semibold, tracking: -0.4
    )
    public static let title = Style(
        kind: .sans, size: 22, lineHeight: 28,
        weight: .semibold, nsWeight: .semibold, tracking: -0.2
    )
    public static let heading = Style(
        kind: .sans, size: 17, lineHeight: 24,
        weight: .semibold, nsWeight: .semibold, tracking: 0
    )
    public static let body = Style(
        kind: .sans, size: 13, lineHeight: 18,
        weight: .regular, nsWeight: .regular, tracking: 0
    )
    public static let caption = Style(
        kind: .sans, size: 11, lineHeight: 14,
        weight: .medium, nsWeight: .medium, tracking: 0.1
    )
    public static let mono = Style(
        kind: .mono, size: 13, lineHeight: 18,
        weight: .regular, nsWeight: .regular, tracking: 0
    )

    /// All ramp styles, ordered display → caption → mono. Used by the
    /// catalog to render the full ramp.
    public static let all: [(name: String, style: Style)] = [
        ("display",  display),
        ("title",    title),
        ("heading",  heading),
        ("body",     body),
        ("caption",  caption),
        ("mono",     mono)
    ]
}
