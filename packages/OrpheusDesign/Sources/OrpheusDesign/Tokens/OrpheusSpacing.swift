import CoreGraphics

/// 4-pixel base spacing scale.
///
/// LOCKED in `extras/specs/design-principles.md`:
/// `spacing.0 … spacing.8` → `0, 4, 8, 12, 16, 24, 32, 48, 64`.
///
/// Both the index-named and semantic-named accessors are exposed because
/// each call site reads more naturally with a different style: layout code
/// lives close to the grid (`step1`/`step2`), but components more often want
/// a reading-friendly name (`sm`/`md`).
public enum OrpheusSpacing {
    public static let step0: CGFloat = 0     // hairlines / zero-padding
    public static let step1: CGFloat = 4     // xxs
    public static let step2: CGFloat = 8     // xs
    public static let step3: CGFloat = 12    // sm
    public static let step4: CGFloat = 16    // md
    public static let step5: CGFloat = 24    // lg
    public static let step6: CGFloat = 32    // xl
    public static let step7: CGFloat = 48    // 2xl
    public static let step8: CGFloat = 64    // 3xl

    public static let none:  CGFloat = step0
    public static let xxs:   CGFloat = step1
    public static let xs:    CGFloat = step2
    public static let sm:    CGFloat = step3
    public static let md:    CGFloat = step4
    public static let lg:    CGFloat = step5
    public static let xl:    CGFloat = step6
    public static let xxl:   CGFloat = step7
    public static let huge:  CGFloat = step8

    /// All spacing values, ordered shallowest → deepest. Used by the
    /// catalog to render the scale and by tests to verify the 4-pixel
    /// grid invariant.
    public static let all: [CGFloat] = [
        step0, step1, step2, step3, step4, step5, step6, step7, step8
    ]
}
