import XCTest
import CoreGraphics
@testable import OrpheusCore

final class LayoutSpecTests: XCTestCase {

    private let termA = TerminalID(rawValue: "term-A")
    private let termB = TerminalID(rawValue: "term-B")
    private let termC = TerminalID(rawValue: "term-C")

    private func encode(_ spec: LayoutSpec) throws -> Data {
        try JSONEncoder().encode(spec)
    }

    private func decode(_ data: Data) throws -> LayoutSpec {
        try JSONDecoder().decode(LayoutSpec.self, from: data)
    }

    func testLeafRoundTrip() throws {
        let spec = LayoutSpec.leaf(termA)
        let decoded = try decode(encode(spec))
        XCTAssertEqual(spec, decoded)
    }

    func testSplitHorizontalRoundTrip() throws {
        let spec = LayoutSpec.split(
            axis: .horizontal,
            lhs: .leaf(termA),
            rhs: .leaf(termB),
            fraction: 0.4
        )
        let decoded = try decode(encode(spec))
        XCTAssertEqual(spec, decoded)
    }

    func testSplitVerticalRoundTrip() throws {
        let spec = LayoutSpec.split(
            axis: .vertical,
            lhs: .leaf(termA),
            rhs: .leaf(termB),
            fraction: 0.6
        )
        let decoded = try decode(encode(spec))
        XCTAssertEqual(spec, decoded)
    }

    func testNestedSplitRoundTrip() throws {
        // split(lhs: split(...), rhs: leaf) — the recursive case that historically breaks Codable synthesis
        let inner = LayoutSpec.split(
            axis: .horizontal,
            lhs: .leaf(termA),
            rhs: .leaf(termB),
            fraction: 0.5
        )
        let outer = LayoutSpec.split(
            axis: .vertical,
            lhs: inner,
            rhs: .leaf(termC),
            fraction: 0.7
        )
        let decoded = try decode(encode(outer))
        XCTAssertEqual(outer, decoded)
    }

    func testDeeplyNestedSplitRoundTrip() throws {
        let leaf1 = LayoutSpec.leaf(termA)
        let leaf2 = LayoutSpec.leaf(termB)
        let leaf3 = LayoutSpec.leaf(termC)
        let split1 = LayoutSpec.split(axis: .horizontal, lhs: leaf1, rhs: leaf2, fraction: 0.5)
        let split2 = LayoutSpec.split(axis: .vertical, lhs: split1, rhs: leaf3, fraction: 0.6)
        let root = LayoutSpec.split(axis: .horizontal, lhs: split2, rhs: leaf1, fraction: 0.4)
        let decoded = try decode(encode(root))
        XCTAssertEqual(root, decoded)
    }

    func testCanvasRoundTrip() throws {
        let placements = [
            CanvasPlacement(terminalID: termA, frame: CGRect(x: 0, y: 0, width: 400, height: 300)),
            CanvasPlacement(terminalID: termB, frame: CGRect(x: 410, y: 0, width: 400, height: 300)),
        ]
        let spec = LayoutSpec.canvas(placements)
        let decoded = try decode(encode(spec))
        XCTAssertEqual(spec, decoded)
    }

    func testEmptyCanvasRoundTrip() throws {
        let spec = LayoutSpec.canvas([])
        let decoded = try decode(encode(spec))
        XCTAssertEqual(spec, decoded)
    }

    func testLayoutPositionSlotRoundTrip() throws {
        let pos = LayoutPosition.slot(index: 2)
        let data = try JSONEncoder().encode(pos)
        let decoded = try JSONDecoder().decode(LayoutPosition.self, from: data)
        XCTAssertEqual(pos, decoded)
    }

    func testLayoutPositionCanvasFrameRoundTrip() throws {
        let pos = LayoutPosition.canvasFrame(CGRect(x: 10, y: 20, width: 300, height: 200))
        let data = try JSONEncoder().encode(pos)
        let decoded = try JSONDecoder().decode(LayoutPosition.self, from: data)
        XCTAssertEqual(pos, decoded)
    }

    func testSplitAxisRawValues() {
        XCTAssertEqual(SplitAxis.horizontal.rawValue, "horizontal")
        XCTAssertEqual(SplitAxis.vertical.rawValue, "vertical")
    }

    func testCanvasPlacementRoundTrip() throws {
        let placement = CanvasPlacement(
            terminalID: TerminalID(rawValue: "t-1"),
            frame: CGRect(x: 5, y: 10, width: 640, height: 480)
        )
        let data = try JSONEncoder().encode(placement)
        let decoded = try JSONDecoder().decode(CanvasPlacement.self, from: data)
        XCTAssertEqual(placement, decoded)
    }
}
