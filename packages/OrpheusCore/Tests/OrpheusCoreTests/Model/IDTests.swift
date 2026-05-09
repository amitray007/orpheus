import XCTest
@testable import OrpheusCore

final class IDTests: XCTestCase {

    // MARK: - ProjectID

    func testProjectIDRoundTrip() throws {
        let original = ProjectID(rawValue: "test-project-123")
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ProjectID.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testProjectIDDefaultInit() {
        let id = ProjectID()
        XCTAssertFalse(id.rawValue.isEmpty)
        XCTAssertNotNil(UUID(uuidString: id.rawValue))
    }

    func testProjectIDDescription() {
        let id = ProjectID(rawValue: "abc-123")
        XCTAssertEqual(id.description, "abc-123")
    }

    func testProjectIDHashable() {
        let a = ProjectID(rawValue: "same")
        let b = ProjectID(rawValue: "same")
        let c = ProjectID(rawValue: "different")
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
        XCTAssertEqual(a.hashValue, b.hashValue)
    }

    func testProjectIDUniqueness() {
        let a = ProjectID()
        let b = ProjectID()
        XCTAssertNotEqual(a, b)
    }

    // MARK: - SpaceID

    func testSpaceIDRoundTrip() throws {
        let original = SpaceID(rawValue: "test-space-456")
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(SpaceID.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testSpaceIDDefaultInit() {
        let id = SpaceID()
        XCTAssertNotNil(UUID(uuidString: id.rawValue))
    }

    func testSpaceIDDescription() {
        let id = SpaceID(rawValue: "space-xyz")
        XCTAssertEqual(id.description, "space-xyz")
    }

    func testSpaceIDHashable() {
        let a = SpaceID(rawValue: "same")
        let b = SpaceID(rawValue: "same")
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.hashValue, b.hashValue)
    }

    // MARK: - TerminalID

    func testTerminalIDRoundTrip() throws {
        let original = TerminalID(rawValue: "term-789")
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(TerminalID.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testTerminalIDDefaultInit() {
        let id = TerminalID()
        XCTAssertNotNil(UUID(uuidString: id.rawValue))
    }

    func testTerminalIDDescription() {
        let id = TerminalID(rawValue: "term-abc")
        XCTAssertEqual(id.description, "term-abc")
    }

    func testTerminalIDHashable() {
        let a = TerminalID(rawValue: "same")
        let b = TerminalID(rawValue: "same")
        XCTAssertEqual(a, b)
    }

    // MARK: - SessionID

    func testSessionIDRoundTrip() throws {
        let original = SessionID(rawValue: "sess-abc-def")
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(SessionID.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testSessionIDDefaultInit() {
        let id = SessionID()
        XCTAssertNotNil(UUID(uuidString: id.rawValue))
    }

    func testSessionIDDescription() {
        let id = SessionID(rawValue: "sess-1")
        XCTAssertEqual(id.description, "sess-1")
    }

    func testSessionIDHashable() {
        let a = SessionID(rawValue: "same")
        let b = SessionID(rawValue: "same")
        XCTAssertEqual(a, b)
    }

    // MARK: - Cross-type inequality

    func testIDTypesAreDistinct() {
        // Different ID types with same rawValue must not be confusable at the type level.
        let raw = "shared-raw-value"
        let proj = ProjectID(rawValue: raw)
        let space = SpaceID(rawValue: raw)
        XCTAssertEqual(proj.rawValue, space.rawValue)
        // They are different Swift types — the compiler enforces this; no runtime assertion needed.
    }
}
