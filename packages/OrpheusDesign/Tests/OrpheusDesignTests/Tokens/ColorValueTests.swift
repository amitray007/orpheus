import XCTest
@testable import OrpheusDesign

/// Verifies every hex value in `OrpheusPalette` matches the LOCKED v0 values
/// recorded in `extras/specs/design-principles.md`. Drift from these without
/// a corresponding spec update is a regression.
final class ColorValueTests: XCTestCase {

    // MARK: Dark palette — surfaces

    func testDarkSurfaces() {
        let s = OrpheusPalette.dark.surface
        XCTAssertEqual(s.base.hex,     0x16130F)
        XCTAssertEqual(s.raised.hex,   0x1E1A16)
        XCTAssertEqual(s.elevated.hex, 0x28231D)
        XCTAssertEqual(s.overlay.hex,  0x332D26)
    }

    func testDarkText() {
        let t = OrpheusPalette.dark.text
        XCTAssertEqual(t.primary.hex,   0xF5EFE6)
        XCTAssertEqual(t.secondary.hex, 0xA89F92)
        XCTAssertEqual(t.tertiary.hex,  0x6B6358)
        XCTAssertEqual(t.disabled.hex,  0x4A453F)
        XCTAssertEqual(t.inverted.hex,  0x1A1814)
    }

    func testDarkBorders() {
        let b = OrpheusPalette.dark.border
        XCTAssertEqual(b.subtle.hex,  0x2C2723)
        XCTAssertEqual(b.default.hex, 0x3A352E)
        XCTAssertEqual(b.strong.hex,  0x4D4741)
    }

    func testDarkAccent() {
        let a = OrpheusPalette.dark.accent
        XCTAssertEqual(a.primary.hex, 0xD9A441)
        XCTAssertEqual(a.hover.hex,   0xE6B04E)
        XCTAssertEqual(a.pressed.hex, 0xBE8F35)
        XCTAssertEqual(a.subtle.hex,  0xD9A441)
        XCTAssertEqual(a.subtle.opacity, 0.12, accuracy: 0.001)
    }

    func testDarkSemantic() {
        let s = OrpheusPalette.dark.semantic
        XCTAssertEqual(s.success.hex,  0x6FA378)
        XCTAssertEqual(s.warning.hex,  0xD89E5C)
        XCTAssertEqual(s.critical.hex, 0xC96A5F)
        XCTAssertEqual(s.info.hex,     0x7899B0)
    }

    func testDarkGlass() {
        let g = OrpheusPalette.dark.glass
        XCTAssertEqual(g.tint.hex,     0x241F1A)
        XCTAssertEqual(g.tint.opacity, 0.50, accuracy: 0.001)
        XCTAssertEqual(g.highlight.hex,     0xFFFFFF)
        XCTAssertEqual(g.highlight.opacity, 0.06, accuracy: 0.001)
    }

    // MARK: Light palette — surfaces

    func testLightSurfaces() {
        let s = OrpheusPalette.light.surface
        XCTAssertEqual(s.base.hex,     0xFAF7F2)
        XCTAssertEqual(s.raised.hex,   0xF2ECE3)
        XCTAssertEqual(s.elevated.hex, 0xE8DFD2)
        XCTAssertEqual(s.overlay.hex,  0xD9CFC0)
    }

    func testLightText() {
        let t = OrpheusPalette.light.text
        XCTAssertEqual(t.primary.hex,   0x1A1815)
        XCTAssertEqual(t.secondary.hex, 0x5C554B)
        XCTAssertEqual(t.tertiary.hex,  0x8A8175)
        XCTAssertEqual(t.disabled.hex,  0xB0A899)
        XCTAssertEqual(t.inverted.hex,  0xFAF7F2)
    }

    func testLightBorders() {
        let b = OrpheusPalette.light.border
        XCTAssertEqual(b.subtle.hex,  0xE5DED1)
        XCTAssertEqual(b.default.hex, 0xCFC5B3)
        XCTAssertEqual(b.strong.hex,  0xA89F8B)
    }

    func testLightAccent() {
        let a = OrpheusPalette.light.accent
        XCTAssertEqual(a.primary.hex, 0xB88A2E)
        XCTAssertEqual(a.hover.hex,   0xC99937)
        XCTAssertEqual(a.pressed.hex, 0x9E7625)
        XCTAssertEqual(a.subtle.hex,  0xB88A2E)
        XCTAssertEqual(a.subtle.opacity, 0.10, accuracy: 0.001)
    }

    func testLightSemantic() {
        let s = OrpheusPalette.light.semantic
        XCTAssertEqual(s.success.hex,  0x4A7A56)
        XCTAssertEqual(s.warning.hex,  0xB57A2D)
        XCTAssertEqual(s.critical.hex, 0xA04A3F)
        XCTAssertEqual(s.info.hex,     0x4C7590)
    }

    func testLightGlass() {
        let g = OrpheusPalette.light.glass
        XCTAssertEqual(g.tint.hex,     0xF2ECE3)
        XCTAssertEqual(g.tint.opacity, 0.60, accuracy: 0.001)
        XCTAssertEqual(g.highlight.hex,     0xFFFFFF)
        XCTAssertEqual(g.highlight.opacity, 0.40, accuracy: 0.001)
    }
}
