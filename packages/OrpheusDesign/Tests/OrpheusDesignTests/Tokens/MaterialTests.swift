import XCTest
@testable import OrpheusDesign

/// Verifies the four LOCKED material specs (`extras/specs/design-principles.md`)
/// match the values the design-system surface actually exposes.
final class MaterialTests: XCTestCase {

    func testSidebarSpec() {
        let m = OrpheusMaterial.sidebar
        XCTAssertEqual(m.blurRadius, 20)
        XCTAssertEqual(m.tint.dark.opacity,  0.50, accuracy: 0.001)
        XCTAssertEqual(m.tint.light.opacity, 0.60, accuracy: 0.001)
        XCTAssertEqual(m.saturationBoost, 1.20, accuracy: 0.001)
        XCTAssertEqual(m.rim, .none)
    }

    func testPaletteSpec() {
        let m = OrpheusMaterial.palette
        XCTAssertEqual(m.blurRadius, 40)
        XCTAssertEqual(m.tint.dark.opacity,  0.70, accuracy: 0.001)
        XCTAssertEqual(m.tint.light.opacity, 0.75, accuracy: 0.001)
        XCTAssertEqual(m.saturationBoost, 1.15, accuracy: 0.001)
        XCTAssertEqual(m.rim, .full(width: 1.5))
    }

    func testToolbarSpec() {
        let m = OrpheusMaterial.toolbar
        XCTAssertEqual(m.blurRadius, 15)
        XCTAssertEqual(m.tint.dark.opacity,  0.40, accuracy: 0.001)
        XCTAssertEqual(m.tint.light.opacity, 0.50, accuracy: 0.001)
        XCTAssertEqual(m.saturationBoost, 1.10, accuracy: 0.001)
        XCTAssertEqual(m.rim, .bottomEdge(width: 1))
    }

    func testOverlaySpec() {
        let m = OrpheusMaterial.overlay
        XCTAssertEqual(m.blurRadius, 30)
        XCTAssertEqual(m.tint.dark.opacity,  0.65, accuracy: 0.001)
        XCTAssertEqual(m.tint.light.opacity, 0.70, accuracy: 0.001)
        XCTAssertEqual(m.saturationBoost, 1.15, accuracy: 0.001)
        XCTAssertEqual(m.rim, .full(width: 1))
    }

    /// Blur radii form a strict ladder (toolbar < sidebar < overlay <
    /// palette) — keeps the design ladder enforced by tests.
    func testBlurLadderIsMonotonic() {
        XCTAssertLessThan(OrpheusMaterial.toolbar.blurRadius,
                          OrpheusMaterial.sidebar.blurRadius)
        XCTAssertLessThan(OrpheusMaterial.sidebar.blurRadius,
                          OrpheusMaterial.overlay.blurRadius)
        XCTAssertLessThan(OrpheusMaterial.overlay.blurRadius,
                          OrpheusMaterial.palette.blurRadius)
    }
}
