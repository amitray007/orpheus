import XCTest
@testable import OrpheusCore

final class ProjectTests: XCTestCase {

    private func makeProject() -> Project {
        Project(
            id: ProjectID(rawValue: "proj-001"),
            name: "Orpheus",
            rootPath: "/tmp/orpheus",
            lifecycleState: .active,
            tags: ["swift", "macos"],
            createdAt: Date(timeIntervalSince1970: 1_000_000),
            updatedAt: Date(timeIntervalSince1970: 2_000_000)
        )
    }

    func testRoundTrip() throws {
        let original = makeProject()
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Project.self, from: data)
        XCTAssertEqual(original, decoded)
    }

    func testAllFieldsPreserved() throws {
        let original = makeProject()
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Project.self, from: data)
        XCTAssertEqual(decoded.id, original.id)
        XCTAssertEqual(decoded.name, original.name)
        XCTAssertEqual(decoded.rootPath, original.rootPath)
        XCTAssertEqual(decoded.lifecycleState, original.lifecycleState)
        XCTAssertEqual(decoded.tags, original.tags)
        XCTAssertEqual(decoded.createdAt, original.createdAt)
        XCTAssertEqual(decoded.updatedAt, original.updatedAt)
    }

    func testEmptyTags() throws {
        let project = Project(name: "Empty tags", rootPath: "/tmp/p", lifecycleState: .active, tags: [])
        let data = try JSONEncoder().encode(project)
        let decoded = try JSONDecoder().decode(Project.self, from: data)
        XCTAssertTrue(decoded.tags.isEmpty)
    }

    func testDefaultInitValues() {
        let project = Project(name: "Test", rootPath: "/tmp/test")
        XCTAssertEqual(project.lifecycleState, .active)
        XCTAssertTrue(project.tags.isEmpty)
        XCTAssertNotNil(UUID(uuidString: project.id.rawValue))
    }

    func testHashable() {
        let p1 = makeProject()
        let p2 = makeProject()
        XCTAssertEqual(p1, p2)
        var set = Set<Project>()
        set.insert(p1)
        set.insert(p2)
        XCTAssertEqual(set.count, 1)
    }
}
