import XCTest
@testable import OrpheusCore

final class LifecycleStateTests: XCTestCase {

    func testRawValues() {
        XCTAssertEqual(LifecycleState.active.rawValue, "active")
        XCTAssertEqual(LifecycleState.paused.rawValue, "paused")
        XCTAssertEqual(LifecycleState.archived.rawValue, "archived")
        XCTAssertEqual(LifecycleState.pinned.rawValue, "pinned")
    }

    func testAllCasesCount() {
        XCTAssertEqual(LifecycleState.allCases.count, 4)
    }

    func testRoundTripEachCase() throws {
        for state in LifecycleState.allCases {
            let data = try JSONEncoder().encode(state)
            let decoded = try JSONDecoder().decode(LifecycleState.self, from: data)
            XCTAssertEqual(state, decoded)
        }
    }

    func testDecodesFromRawString() throws {
        let json = "\"archived\"".data(using: .utf8)!
        let decoded = try JSONDecoder().decode(LifecycleState.self, from: json)
        XCTAssertEqual(decoded, .archived)
    }
}
