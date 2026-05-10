import XCTest
@testable import OrpheusTerminal

final class PaletteTests: XCTestCase {

    func testOrpheusDefaultHasNonZeroAlphaForAllFields() {
        let palette = TerminalPalette.orpheusDefault
        XCTAssertGreaterThan(palette.foreground.opacity, 0)
        XCTAssertGreaterThan(palette.background.opacity, 0)
        XCTAssertGreaterThan(palette.cursor.opacity, 0)
        XCTAssertGreaterThan(palette.selection.opacity, 0)
    }

    func testAnsiPaletteHasSixteenColors() {
        let palette = TerminalPalette.orpheusDefault
        XCTAssertEqual(palette.ansi.colors.count, 16)
    }

    func testAllAnsiColorsHaveNonZeroAlpha() {
        let palette = TerminalPalette.orpheusDefault
        for (index, color) in palette.ansi.colors.enumerated() {
            XCTAssertGreaterThan(color.opacity, 0, "ANSI color at index \(index) has zero opacity")
        }
    }

    func testAnsiPaletteHexStringsAreValidSixDigit() {
        let palette = TerminalPalette.orpheusDefault
        for color in palette.ansi.colors {
            XCTAssertEqual(color.hexString.count, 6, "hex string should be 6 chars: \(color.hexString)")
            XCTAssertTrue(
                color.hexString.allSatisfy { $0.isHexDigit },
                "hex string should contain only hex digits: \(color.hexString)"
            )
        }
    }

    func testForegroundAndBackgroundAreDistinct() {
        let palette = TerminalPalette.orpheusDefault
        XCTAssertNotEqual(palette.foreground.hex, palette.background.hex)
    }

    func testMakeConfigurationProducesNonEmptyOutput() {
        let config = makeConfiguration(for: .orpheusDefault)
        XCTAssertFalse(config.rendered.isEmpty)
        XCTAssertTrue(config.rendered.contains("background"))
        XCTAssertTrue(config.rendered.contains("foreground"))
    }

    func testMakeConfigurationContainsAllSixteenPaletteEntries() {
        let config = makeConfiguration(for: .orpheusDefault)
        let rendered = config.rendered
        for index in 0..<16 {
            XCTAssertTrue(
                rendered.contains("palette = \(index)="),
                "Missing palette entry for index \(index)"
            )
        }
    }

    func testRGBAHexStringFormat() {
        let color = TerminalPalette.RGBA(hex: 0xD9A441)
        XCTAssertEqual(color.hexString, "D9A441")
    }

    func testRGBAHexStringZeroPads() {
        let color = TerminalPalette.RGBA(hex: 0x001122)
        XCTAssertEqual(color.hexString, "001122")
    }
}
