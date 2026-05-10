import XCTest
import Foundation
@testable import OrpheusCore

final class JSONLLineParserTests: XCTestCase {

    private var tmpDir: URL!
    private let parser = JSONLLineParser()

    override func setUp() async throws {
        tmpDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("JSONLLineParserTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // MARK: - Helpers

    private func file(_ name: String) -> URL {
        tmpDir.appendingPathComponent(name)
    }

    private func write(_ content: String, to url: URL) throws {
        try content.data(using: .utf8)!.write(to: url, options: .atomic)
    }

    private func headerLine(
        sessionId: String = "abc-123",
        cwd: String = "/Users/me/project",
        gitBranch: String? = "main",
        name: String? = nil
    ) -> String {
        var dict: [String: Any] = ["sessionId": sessionId, "cwd": cwd]
        if let b = gitBranch { dict["gitBranch"] = b }
        if let n = name { dict["name"] = n }
        let data = try! JSONSerialization.data(withJSONObject: dict)
        return String(data: data, encoding: .utf8)!
    }

    private func lastLine(
        lastUpdated: String = "2026-01-15T12:00:00.000Z",
        type: String = "assistant"
    ) -> String {
        let dict: [String: Any] = ["lastUpdated": lastUpdated, "type": type]
        let data = try! JSONSerialization.data(withJSONObject: dict)
        return String(data: data, encoding: .utf8)!
    }

    // MARK: - Empty file → nil

    func testEmptyFileReturnsNil() throws {
        let url = file("empty.jsonl")
        try write("", to: url)
        let result = try parser.parse(fileURL: url)
        XCTAssertNil(result, "Empty file should return nil")
    }

    // MARK: - Header only (valid)

    func testHeaderOnlyReturnsMtimeFallback() throws {
        let url = file("header-only.jsonl")
        try write(headerLine() + "\n", to: url)
        let result = try parser.parse(fileURL: url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.sessionID.rawValue, "abc-123")
        XCTAssertEqual(result?.cwd, "/Users/me/project")
        XCTAssertEqual(result?.gitBranch, "main")
        XCTAssertNil(result?.lastMessageKind)
        // lastUpdated should be close to now (mtime fallback).
        XCTAssertTrue(abs(result!.lastUpdated.timeIntervalSinceNow) < 10)
    }

    // MARK: - Header + last line (full)

    func testFullFileParsesSmokeTest() throws {
        let url = file("full.jsonl")
        let content = headerLine(name: "My Session") + "\n"
            + lastLine() + "\n"
        try write(content, to: url)
        let result = try parser.parse(fileURL: url)
        XCTAssertNotNil(result)
        XCTAssertEqual(result?.name, "My Session")
        XCTAssertEqual(result?.lastMessageKind, "assistant")
        // ISO8601 date should parse to exactly that timestamp.
        XCTAssertNotNil(result?.lastUpdated)
        // Check the year to ensure it parsed correctly.
        let year = Calendar.current.component(.year, from: result!.lastUpdated)
        XCTAssertEqual(year, 2026)
    }

    // MARK: - Header with chat history in middle

    func testMiddleLinesAreIgnored() throws {
        let url = file("middle.jsonl")
        let content = headerLine() + "\n"
            + "{\"role\":\"user\",\"content\":\"hello\"}\n"
            + "{\"role\":\"assistant\",\"content\":\"hi\"}\n"
            + lastLine(type: "tool_result") + "\n"
        try write(content, to: url)
        let result = try parser.parse(fileURL: url)
        XCTAssertEqual(result?.lastMessageKind, "tool_result")
    }

    // MARK: - Malformed header → throw

    func testMalformedHeaderThrows() throws {
        let url = file("bad-header.jsonl")
        try write("NOT JSON\n" + lastLine() + "\n", to: url)
        XCTAssertThrowsError(try parser.parse(fileURL: url)) { error in
            guard case OrpheusCoreError.corruptJSONL(let path, let line) = error else {
                return XCTFail("Expected corruptJSONL, got \(error)")
            }
            XCTAssertTrue(path.contains("bad-header.jsonl"))
            XCTAssertEqual(line, 1)
        }
    }

    func testHeaderMissingSessionIdThrows() throws {
        let url = file("no-sid.jsonl")
        let noSid = "{\"cwd\":\"/some/path\"}\n" + lastLine() + "\n"
        try write(noSid, to: url)
        XCTAssertThrowsError(try parser.parse(fileURL: url)) { error in
            guard case OrpheusCoreError.corruptJSONL(_, let line) = error else {
                return XCTFail("Expected corruptJSONL")
            }
            XCTAssertEqual(line, 1)
        }
    }

    func testHeaderMissingCwdThrows() throws {
        let url = file("no-cwd.jsonl")
        let noCwd = "{\"sessionId\":\"sid-1\"}\n" + lastLine() + "\n"
        try write(noCwd, to: url)
        XCTAssertThrowsError(try parser.parse(fileURL: url)) { error in
            guard case OrpheusCoreError.corruptJSONL(_, let line) = error else {
                return XCTFail("Expected corruptJSONL")
            }
            XCTAssertEqual(line, 1)
        }
    }

    // MARK: - Malformed last line → mtime fallback (no throw)

    func testMalformedLastLineUsesMtime() throws {
        let url = file("bad-last.jsonl")
        let content = headerLine() + "\n"
            + "PARTIAL JSON LINE"
        try write(content, to: url)
        // Should NOT throw — falls back to mtime.
        let result = try parser.parse(fileURL: url)
        XCTAssertNotNil(result)
        XCTAssertNil(result?.lastMessageKind)
    }

    // MARK: - Trailing partial write (no terminating newline)

    func testTrailingPartialWriteUsesLastCompleteMessage() throws {
        let url = file("partial.jsonl")
        let content = headerLine() + "\n"
            + lastLine(type: "user") + "\n"
            + "{\"role\":\"assistant\",\"content\":\"hel"  // partial write, no newline
        try write(content, to: url)
        let result = try parser.parse(fileURL: url)
        XCTAssertNotNil(result)
        // The partial line is ignored; the last complete line (type=user) is used.
        XCTAssertEqual(result?.lastMessageKind, "user")
    }

    // MARK: - Optional fields

    func testGitBranchAbsent() throws {
        let url = file("no-branch.jsonl")
        let header = "{\"sessionId\":\"s1\",\"cwd\":\"/p\"}\n"
        try write(header + lastLine() + "\n", to: url)
        let result = try parser.parse(fileURL: url)
        XCTAssertNil(result?.gitBranch)
    }

    func testNameField() throws {
        let url = file("named.jsonl")
        try write(headerLine(name: "Debug Session") + "\n" + lastLine() + "\n", to: url)
        let result = try parser.parse(fileURL: url)
        XCTAssertEqual(result?.name, "Debug Session")
    }

    // MARK: - ISO8601 without fractional seconds

    func testISO8601WithoutFractionalSeconds() throws {
        let url = file("no-frac.jsonl")
        let last = "{\"lastUpdated\":\"2025-12-01T09:30:00Z\",\"type\":\"user\"}\n"
        try write(headerLine() + "\n" + last, to: url)
        let result = try parser.parse(fileURL: url)
        XCTAssertNotNil(result?.lastUpdated)
        let comps = Calendar.current.dateComponents([.year, .month, .day], from: result!.lastUpdated)
        XCTAssertEqual(comps.year, 2025)
        XCTAssertEqual(comps.month, 12)
        XCTAssertEqual(comps.day, 1)
    }

    // MARK: - Large file (performance path — backward scan)

    func testLargeFileOnlyReadsEdges() throws {
        let url = file("large.jsonl")
        // Write header, 1000 middle lines, then a distinct last line.
        var content = headerLine(sessionId: "large-sid", cwd: "/large") + "\n"
        for i in 0..<1000 {
            content += "{\"role\":\"user\",\"seq\":\(i)}\n"
        }
        content += lastLine(type: "summary") + "\n"
        try write(content, to: url)

        let result = try parser.parse(fileURL: url)
        XCTAssertEqual(result?.sessionID.rawValue, "large-sid")
        XCTAssertEqual(result?.lastMessageKind, "summary")
    }

    // MARK: - File does not exist → nil (no crash)

    func testNonExistentFileReturnsNil() throws {
        let url = file("ghost.jsonl")
        let result = try parser.parse(fileURL: url)
        XCTAssertNil(result)
    }
}
