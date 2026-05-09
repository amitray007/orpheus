import CoreGraphics

/// Corner-radius scale.
///
/// LOCKED in `extras/specs/design-principles.md`:
/// `radius.0 = 0`, `radius.1 = 4` (small chips), `radius.2 = 6` (buttons),
/// `radius.3 = 8` (cards), `radius.4 = 12` (modals), `radius.full` (pill).
///
/// `pill` is a sentinel: components clamp it to half their height at draw
/// time so the value works regardless of element size.
public enum OrpheusRadius {
    public static let none:    CGFloat = 0
    public static let chip:    CGFloat = 4
    public static let button:  CGFloat = 6
    public static let card:    CGFloat = 8
    public static let modal:   CGFloat = 12

    /// Sentinel value asking the consumer to compute `height / 2`. The
    /// sentinel is large enough to never collide with a real radius and
    /// small enough to debug at a glance.
    public static let pill: CGFloat = 9_999

    /// Resolve `pill` against an actual height; pass through every other
    /// value untouched. Components draw with this rather than reading
    /// the raw token, so callers don't have to think about pill clamping.
    public static func resolved(_ radius: CGFloat, forHeight height: CGFloat) -> CGFloat {
        radius == pill ? height / 2 : radius
    }
}
