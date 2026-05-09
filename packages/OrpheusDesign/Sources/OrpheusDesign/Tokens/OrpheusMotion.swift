import SwiftUI

/// Spring-based motion tokens. Every animation in `OrpheusDesign` (and in
/// every consumer module) goes through one of these four presets — drift
/// from this set is reviewable in PRs.
///
/// LOCKED in `extras/specs/design-principles.md`:
/// - `quick`     — response 0.20, damping 0.90 (hover, press)
/// - `standard`  — response 0.30, damping 0.80 (open/close, pane changes)
/// - `settle`    — response 0.40, damping 0.70 (layout rearrangement)
/// - `dramatic`  — response 0.50, damping 0.65 (palette entrance, modals)
///
/// All animations must be interruptible — the spring presets here support
/// that natively in SwiftUI.
public enum OrpheusMotion {

    public struct SpringPreset: Sendable, Equatable {
        public let response: Double
        public let dampingFraction: Double

        public init(response: Double, dampingFraction: Double) {
            self.response = response
            self.dampingFraction = dampingFraction
        }

        /// SwiftUI animation built from this preset. Recomputed on each
        /// call so reduce-motion overrides honoured upstream still apply.
        public var animation: Animation {
            .spring(response: response, dampingFraction: dampingFraction)
        }
    }

    public static let quick    = SpringPreset(response: 0.20, dampingFraction: 0.90)
    public static let standard = SpringPreset(response: 0.30, dampingFraction: 0.80)
    public static let settle   = SpringPreset(response: 0.40, dampingFraction: 0.70)
    public static let dramatic = SpringPreset(response: 0.50, dampingFraction: 0.65)

    /// Convenience: an `Animation` for callers who don't need the raw
    /// preset components.
    public static var quickAnim:    Animation { quick.animation }
    public static var standardAnim: Animation { standard.animation }
    public static var settleAnim:   Animation { settle.animation }
    public static var dramaticAnim: Animation { dramatic.animation }
}
