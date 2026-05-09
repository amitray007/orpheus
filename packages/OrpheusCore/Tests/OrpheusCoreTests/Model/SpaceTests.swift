import XCTest
import CoreGraphics
@testable import OrpheusCore

final class SpaceTests: XCTestCase {

    private let projectID = ProjectID(rawValue: "proj-001")
    private let termID1 = TerminalID(rawValue: "term-001")
    private let termID2 = TerminalID(rawValue: "term-002")

    private func makeSpaceWithLeafLayout() -> Space {
        Space(
            id: SpaceID(rawValue: "space-001"),
            projectID: projectID,
            name: "Main",
            description: "Primary workspace",
            layoutSpec: .leaf(TerminalID(rawValue: "term-001")),
            ord: 0,
            lifecycleState: .active,
            createdAt: Date(timeIntervalSince1970: 1_000_000),
            updatedAt: Date(timeIntervalSince1970: 2_000_000)
        )
    }

    private func makeSpaceWithSplitLayout() -> Space {
        Space(
            id: SpaceID(rawValue: "space-002"),
            projectID: projectID,
            name: "Split",
            layoutSpec: .split(
                axis: .horizontal,
                lhs: .leaf(TerminalID(rawValue: "term-001")),
                rhs: .leaf(TerminalID(rawValue: "term-002")),
                fraction: 0.5
            ),
            ord: 1
        )
    }

    private func makeSpaceWithCanvasLayout() -> Space {
        let placements = [
            CanvasPlacement(
                terminalID: TerminalID(rawValue: "term-001"),
                frame: CGRect(x: 0, y: 0, width: 800, height: 600)
            ),
            CanvasPlacement(
                terminalID: TerminalID(rawValue: "term-002"),
                frame: CGRect(x: 810, y: 0, width: 400, height: 600)
            )
        ]
        return Space(
            id: SpaceID(rawValue: "space-003"),
            projectID: projectID,
            name: "Canvas",
            layoutSpec: .canvas(placements),
            ord: 2
        )
    }

    func testRoundTripLeaf() throws {
        let original = makeSpaceWithLeafLayout()
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Space.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testRoundTripSplit() throws {
        let original = makeSpaceWithSplitLayout()
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Space.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testRoundTripCanvas() throws {
        let original = makeSpaceWithCanvasLayout()
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Space.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testAllFieldsPreserved() throws {
        let original = makeSpaceWithLeafLayout()
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Space.self, from: data)
        XCTAssertEqual(decoded.id, original.id)
        XCTAssertEqual(decoded.projectID, original.projectID)
        XCTAssertEqual(decoded.name, original.name)
        XCTAssertEqual(decoded.description, original.description)
        XCTAssertEqual(decoded.ord, original.ord)
        XCTAssertEqual(decoded.lifecycleState, original.lifecycleState)
        XCTAssertEqual(decoded.createdAt, original.createdAt)
        XCTAssertEqual(decoded.updatedAt, original.updatedAt)
    }

    func testNilDescription() throws {
        let space = Space(
            projectID: projectID,
            name: "No description",
            layoutSpec: .leaf(termID1)
        )
        let data = try JSONEncoder().encode(space)
        let decoded = try JSONDecoder().decode(Space.self, from: data)
        XCTAssertNil(decoded.description)
    }

    func testDefaultInitValues() {
        let space = Space(projectID: projectID, name: "Test", layoutSpec: .leaf(termID1))
        XCTAssertEqual(space.lifecycleState, .active)
        XCTAssertEqual(space.ord, 0)
        XCTAssertNil(space.description)
    }
}
