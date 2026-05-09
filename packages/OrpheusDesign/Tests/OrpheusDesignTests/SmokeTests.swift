import XCTest
@testable import OrpheusDesign

final class SmokeTests: XCTestCase {
    func testVersionExists() {
        XCTAssertFalse(OrpheusDesign.version.isEmpty)
    }
}
