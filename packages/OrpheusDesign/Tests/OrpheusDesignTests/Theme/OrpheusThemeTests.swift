import SwiftUI
import XCTest
@testable import OrpheusDesign

final class OrpheusThemeTests: XCTestCase {

    func testDarkThemeBundlesDarkPalette() {
        XCTAssertEqual(OrpheusTheme.dark.scheme, .dark)
        XCTAssertEqual(OrpheusTheme.dark.palette.surface.base.hex, 0x16130F)
        XCTAssertEqual(OrpheusTheme.dark.palette.text.primary.hex,  0xF5EFE6)
    }

    func testLightThemeBundlesLightPalette() {
        XCTAssertEqual(OrpheusTheme.light.scheme, .light)
        XCTAssertEqual(OrpheusTheme.light.palette.surface.base.hex, 0xFAF7F2)
        XCTAssertEqual(OrpheusTheme.light.palette.text.primary.hex, 0x1A1815)
    }

    func testDefaultEnvironmentThemeIsDark() {
        // We default to dark in the env so any preview that forgets to
        // wrap in `.orpheusTheme(...)` still renders the daily-driver
        // theme.
        let env = EnvironmentValues()
        XCTAssertEqual(env.orpheusTheme.scheme, .dark)
    }

    func testCustomThemeFromCustomPalette() {
        let custom = OrpheusTheme(scheme: .light, palette: .dark)
        XCTAssertEqual(custom.scheme, .light)
        XCTAssertEqual(custom.palette.surface.base.hex, 0x16130F)
    }
}
