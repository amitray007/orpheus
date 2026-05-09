import XCTest
import CoreGraphics
@testable import OrpheusCore

final class TerminalTests: XCTestCase {

    private let spaceID = SpaceID(rawValue: "space-001")

    private func makeMinimalTerminal() -> Terminal {
        Terminal(
            id: TerminalID(rawValue: "term-001"),
            spaceID: spaceID,
            cwd: "/tmp/project"
        )
    }

    private func makeFullTerminal() -> Terminal {
        Terminal(
            id: TerminalID(rawValue: "term-002"),
            spaceID: spaceID,
            cwd: "/tmp/project",
            command: "claude",
            status: .running,
            claudeSessionID: SessionID(rawValue: "sess-abc"),
            layoutPosition: .slot(index: 0),
            createdAt: Date(timeIntervalSince1970: 1_000_000)
        )
    }

    private func makeCanvasPositionedTerminal() -> Terminal {
        Terminal(
            id: TerminalID(rawValue: "term-003"),
            spaceID: spaceID,
            cwd: "/tmp/other",
            status: .stopped,
            layoutPosition: .canvasFrame(CGRect(x: 10, y: 20, width: 800, height: 600)),
            createdAt: Date(timeIntervalSince1970: 500_000)
        )
    }

    func testRoundTripMinimal() throws {
        let original = makeMinimalTerminal()
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Terminal.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testRoundTripFull() throws {
        let original = makeFullTerminal()
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Terminal.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testRoundTripCanvasPosition() throws {
        let original = makeCanvasPositionedTerminal()
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Terminal.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testNilOptionalsRoundTrip() throws {
        let original = makeMinimalTerminal()
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Terminal.self, from: data)
        XCTAssertNil(decoded.command)
        XCTAssertNil(decoded.claudeSessionID)
        XCTAssertNil(decoded.layoutPosition)
    }

    func testAllOptionalFieldsPopulated() throws {
        let original = makeFullTerminal()
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Terminal.self, from: data)
        XCTAssertEqual(decoded.command, "claude")
        XCTAssertEqual(decoded.claudeSessionID, SessionID(rawValue: "sess-abc"))
        XCTAssertEqual(decoded.layoutPosition, .slot(index: 0))
    }

    func testDefaultInitValues() {
        let terminal = Terminal(spaceID: spaceID, cwd: "/tmp")
        XCTAssertEqual(terminal.status, .stopped)
        XCTAssertNil(terminal.command)
        XCTAssertNil(terminal.claudeSessionID)
        XCTAssertNil(terminal.layoutPosition)
        XCTAssertNotNil(UUID(uuidString: terminal.id.rawValue))
    }

    func testHashable() {
        let t1 = makeFullTerminal()
        let t2 = makeFullTerminal()
        XCTAssertEqual(t1, t2)
    }
}
