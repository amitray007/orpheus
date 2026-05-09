import XCTest
@testable import OrpheusCore

final class TerminalStatusTests: XCTestCase {

    func testRawValues() {
        XCTAssertEqual(TerminalStatus.running.rawValue, "running")
        XCTAssertEqual(TerminalStatus.stopped.rawValue, "stopped")
        XCTAssertEqual(TerminalStatus.crashed.rawValue, "crashed")
        XCTAssertEqual(TerminalStatus.detached.rawValue, "detached")
    }

    func testAllCasesCount() {
        XCTAssertEqual(TerminalStatus.allCases.count, 4)
    }

    func testRoundTripEachCase() throws {
        for status in TerminalStatus.allCases {
            let data = try JSONEncoder().encode(status)
            let decoded = try JSONDecoder().decode(TerminalStatus.self, from: data)
            XCTAssertEqual(status, decoded)
        }
    }

    func testDecodesFromRawString() throws {
        let json = "\"crashed\"".data(using: .utf8)!
        let decoded = try JSONDecoder().decode(TerminalStatus.self, from: json)
        XCTAssertEqual(decoded, .crashed)
    }
}
