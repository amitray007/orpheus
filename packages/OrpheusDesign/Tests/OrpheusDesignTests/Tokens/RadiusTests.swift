import XCTest
@testable import OrpheusDesign

final class RadiusTests: XCTestCase {

    func testRadiusValuesMatchSpec() {
        XCTAssertEqual(OrpheusRadius.none,   0)
        XCTAssertEqual(OrpheusRadius.chip,   4)
        XCTAssertEqual(OrpheusRadius.button, 6)
        XCTAssertEqual(OrpheusRadius.card,   8)
        XCTAssertEqual(OrpheusRadius.modal,  12)
    }

    func testPillResolvesToHalfHeight() {
        XCTAssertEqual(OrpheusRadius.resolved(OrpheusRadius.pill, forHeight: 32), 16)
        XCTAssertEqual(OrpheusRadius.resolved(OrpheusRadius.pill, forHeight: 0),   0)
    }

    func testNonPillRadiiPassThrough() {
        XCTAssertEqual(OrpheusRadius.resolved(OrpheusRadius.button, forHeight: 32), 6)
        XCTAssertEqual(OrpheusRadius.resolved(OrpheusRadius.card,   forHeight: 80), 8)
    }
}
