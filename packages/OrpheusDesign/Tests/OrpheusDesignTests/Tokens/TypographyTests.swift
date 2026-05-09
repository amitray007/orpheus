import XCTest
@testable import OrpheusDesign

final class TypographyTests: XCTestCase {

    func testRampSizes() {
        XCTAssertEqual(OrpheusTypography.display.size,  32)
        XCTAssertEqual(OrpheusTypography.title.size,    22)
        XCTAssertEqual(OrpheusTypography.heading.size,  17)
        XCTAssertEqual(OrpheusTypography.body.size,     13)
        XCTAssertEqual(OrpheusTypography.caption.size,  11)
        XCTAssertEqual(OrpheusTypography.mono.size,     13)
    }

    func testRampLineHeights() {
        XCTAssertEqual(OrpheusTypography.display.lineHeight,  40)
        XCTAssertEqual(OrpheusTypography.title.lineHeight,    28)
        XCTAssertEqual(OrpheusTypography.heading.lineHeight,  24)
        XCTAssertEqual(OrpheusTypography.body.lineHeight,     18)
        XCTAssertEqual(OrpheusTypography.caption.lineHeight,  14)
        XCTAssertEqual(OrpheusTypography.mono.lineHeight,     18)
    }

    func testRampWeights() {
        XCTAssertEqual(OrpheusTypography.display.weight,  .semibold)
        XCTAssertEqual(OrpheusTypography.title.weight,    .semibold)
        XCTAssertEqual(OrpheusTypography.heading.weight,  .semibold)
        XCTAssertEqual(OrpheusTypography.body.weight,     .regular)
        XCTAssertEqual(OrpheusTypography.caption.weight,  .medium)
        XCTAssertEqual(OrpheusTypography.mono.weight,     .regular)
    }

    func testMonoIsMonoSans() {
        XCTAssertEqual(OrpheusTypography.mono.kind,    .mono)
        XCTAssertEqual(OrpheusTypography.body.kind,    .sans)
        XCTAssertEqual(OrpheusTypography.display.kind, .sans)
    }

    /// `lineSpacing` is always non-negative — SwiftUI rejects negatives.
    func testLineSpacingNonNegative() {
        for (_, style) in OrpheusTypography.all {
            XCTAssertGreaterThanOrEqual(style.lineSpacing, 0)
        }
    }

    /// `nsFont` always resolves (either to a registered face or the
    /// system fallback) — no nil sneaks through to AppKit consumers.
    func testNSFontResolves() {
        for (_, style) in OrpheusTypography.all {
            let font = style.nsFont
            XCTAssertEqual(font.pointSize, style.size)
        }
    }
}
