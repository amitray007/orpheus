import XCTest
@testable import OrpheusCore

final class OrpheusCoreErrorTests: XCTestCase {

    private let allCases: [OrpheusCoreError] = [
        .notFound(id: "proj-1", kind: "Project"),
        .invalidParent(child: "space-1", parent: "proj-missing"),
        .migrationFailed(reason: "column already exists"),
        .subprocessSpawn(reason: "binary not found"),
        .corruptJSONL(path: "/tmp/sess.jsonl", line: 42),
        .settingsMergeConflict(key: "terminal.shell"),
    ]

    func testAllCasesHaveNonEmptyErrorDescription() {
        for error in allCases {
            let desc = error.errorDescription
            XCTAssertNotNil(desc, "errorDescription should not be nil for \(error)")
            XCTAssertFalse(desc!.isEmpty, "errorDescription should not be empty for \(error)")
        }
    }

    func testNotFoundDescription() {
        let error = OrpheusCoreError.notFound(id: "x", kind: "Space")
        XCTAssertTrue(error.errorDescription?.contains("x") ?? false)
        XCTAssertTrue(error.errorDescription?.contains("Space") ?? false)
    }

    func testInvalidParentDescription() {
        let error = OrpheusCoreError.invalidParent(child: "child-id", parent: "parent-id")
        XCTAssertTrue(error.errorDescription?.contains("child-id") ?? false)
        XCTAssertTrue(error.errorDescription?.contains("parent-id") ?? false)
    }

    func testMigrationFailedDescription() {
        let error = OrpheusCoreError.migrationFailed(reason: "schema mismatch")
        XCTAssertTrue(error.errorDescription?.contains("schema mismatch") ?? false)
    }

    func testSubprocessSpawnDescription() {
        let error = OrpheusCoreError.subprocessSpawn(reason: "permission denied")
        XCTAssertTrue(error.errorDescription?.contains("permission denied") ?? false)
    }

    func testCorruptJSONLDescription() {
        let error = OrpheusCoreError.corruptJSONL(path: "/var/log/test.jsonl", line: 7)
        let desc = error.errorDescription ?? ""
        XCTAssertTrue(desc.contains("/var/log/test.jsonl"))
        XCTAssertTrue(desc.contains("7"))
    }

    func testSettingsMergeConflictDescription() {
        let error = OrpheusCoreError.settingsMergeConflict(key: "general.theme")
        XCTAssertTrue(error.errorDescription?.contains("general.theme") ?? false)
    }

    func testEquatable() {
        XCTAssertEqual(
            OrpheusCoreError.notFound(id: "a", kind: "Project"),
            OrpheusCoreError.notFound(id: "a", kind: "Project")
        )
        XCTAssertNotEqual(
            OrpheusCoreError.notFound(id: "a", kind: "Project"),
            OrpheusCoreError.notFound(id: "b", kind: "Project")
        )
        XCTAssertNotEqual(
            OrpheusCoreError.migrationFailed(reason: "x"),
            OrpheusCoreError.subprocessSpawn(reason: "x")
        )
    }

    func testConformsToError() {
        let error: Error = OrpheusCoreError.notFound(id: "1", kind: "Terminal")
        XCTAssertNotNil(error as? OrpheusCoreError)
    }
}
