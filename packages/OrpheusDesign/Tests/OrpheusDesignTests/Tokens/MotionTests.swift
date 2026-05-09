import XCTest
@testable import OrpheusDesign

final class MotionTests: XCTestCase {

    func testQuickPreset() {
        XCTAssertEqual(OrpheusMotion.quick.response,        0.20, accuracy: 0.001)
        XCTAssertEqual(OrpheusMotion.quick.dampingFraction, 0.90, accuracy: 0.001)
    }

    func testStandardPreset() {
        XCTAssertEqual(OrpheusMotion.standard.response,        0.30, accuracy: 0.001)
        XCTAssertEqual(OrpheusMotion.standard.dampingFraction, 0.80, accuracy: 0.001)
    }

    func testSettlePreset() {
        XCTAssertEqual(OrpheusMotion.settle.response,        0.40, accuracy: 0.001)
        XCTAssertEqual(OrpheusMotion.settle.dampingFraction, 0.70, accuracy: 0.001)
    }

    func testDramaticPreset() {
        XCTAssertEqual(OrpheusMotion.dramatic.response,        0.50,  accuracy: 0.001)
        XCTAssertEqual(OrpheusMotion.dramatic.dampingFraction, 0.65, accuracy: 0.001)
    }

    /// Sanity: response and damping are within sensible bounds.
    func testPresetsAreSane() {
        let presets: [OrpheusMotion.SpringPreset] = [
            OrpheusMotion.quick,
            OrpheusMotion.standard,
            OrpheusMotion.settle,
            OrpheusMotion.dramatic
        ]
        for preset in presets {
            XCTAssertGreaterThan(preset.response, 0)
            XCTAssertLessThan(preset.response, 2.0)
            XCTAssertGreaterThan(preset.dampingFraction, 0)
            XCTAssertLessThanOrEqual(preset.dampingFraction, 1.0)
        }
    }
}
