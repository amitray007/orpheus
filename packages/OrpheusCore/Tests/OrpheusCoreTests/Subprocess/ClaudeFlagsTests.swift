import XCTest
@testable import OrpheusCore

final class ClaudeFlagsTests: XCTestCase {

    // MARK: - Mode.fresh (default)

    func testFreshModeProducesEmptyArgs() {
        let flags = ClaudeFlags()
        XCTAssertEqual(flags.build(), [])
    }

    func testFreshModeExplicitProducesEmptyArgs() {
        var flags = ClaudeFlags()
        flags.mode = .fresh
        XCTAssertEqual(flags.build(), [])
    }

    // MARK: - Mode.resume

    func testResumeModeProducesResumeFlag() {
        var flags = ClaudeFlags()
        flags.mode = .resume(SessionID(rawValue: "abc-123"))
        XCTAssertEqual(flags.build(), ["--resume", "abc-123"])
    }

    func testResumeModeWithOutputFormat() {
        var flags = ClaudeFlags()
        flags.mode = .resume(SessionID(rawValue: "sess-1"))
        flags.outputFormat = .streamJson
        XCTAssertEqual(flags.build(), ["--resume", "sess-1", "--output-format", "stream-json"])
    }

    // MARK: - Mode.fork

    func testForkModeProducesResumePlusForkFlag() {
        var flags = ClaudeFlags()
        flags.mode = .fork(SessionID(rawValue: "parent-id"))
        XCTAssertEqual(flags.build(), ["--resume", "parent-id", "--fork-session"])
    }

    func testForkModeWithBare() {
        var flags = ClaudeFlags()
        flags.mode = .fork(SessionID(rawValue: "parent-id"))
        flags.bare = true
        XCTAssertEqual(flags.build(), ["--resume", "parent-id", "--fork-session", "--bare"])
    }

    // MARK: - OutputFormat

    func testOutputFormatText() {
        var flags = ClaudeFlags()
        flags.outputFormat = .text
        XCTAssertEqual(flags.build(), ["--output-format", "text"])
    }

    func testOutputFormatStreamJson() {
        var flags = ClaudeFlags()
        flags.outputFormat = .streamJson
        XCTAssertEqual(flags.build(), ["--output-format", "stream-json"])
    }

    // MARK: - Bare

    func testBareFlag() {
        var flags = ClaudeFlags()
        flags.bare = true
        XCTAssertEqual(flags.build(), ["--bare"])
    }

    // MARK: - ExtraArgs

    func testExtraArgsAppendedVerbatim() {
        var flags = ClaudeFlags()
        flags.extraArgs = ["--verbose", "--no-color"]
        XCTAssertEqual(flags.build(), ["--verbose", "--no-color"])
    }

    func testExtraArgsWithResumeAndBare() {
        var flags = ClaudeFlags()
        flags.mode = .resume(SessionID(rawValue: "sid"))
        flags.bare = true
        flags.extraArgs = ["--no-color"]
        XCTAssertEqual(flags.build(), ["--resume", "sid", "--bare", "--no-color"])
    }

    // MARK: - Ordering: output-format before bare

    func testOutputFormatComesBeforeBare() {
        var flags = ClaudeFlags()
        flags.outputFormat = .streamJson
        flags.bare = true
        let result = flags.build()
        let outputIdx = result.firstIndex(of: "--output-format")
        let bareIdx = result.firstIndex(of: "--bare")
        XCTAssertNotNil(outputIdx)
        XCTAssertNotNil(bareIdx)
        XCTAssertLessThan(outputIdx!, bareIdx!)
    }

    // MARK: - Equatable

    func testEquatableSameFlags() {
        var a = ClaudeFlags()
        a.mode = .resume(SessionID(rawValue: "x"))
        a.bare = true
        var b = ClaudeFlags()
        b.mode = .resume(SessionID(rawValue: "x"))
        b.bare = true
        XCTAssertEqual(a, b)
    }

    func testEquatableDifferentMode() {
        var a = ClaudeFlags()
        a.mode = .resume(SessionID(rawValue: "x"))
        var b = ClaudeFlags()
        b.mode = .fresh
        XCTAssertNotEqual(a, b)
    }

    // MARK: - OutputFormat rawValue

    func testOutputFormatRawValues() {
        XCTAssertEqual(OutputFormat.streamJson.rawValue, "stream-json")
        XCTAssertEqual(OutputFormat.text.rawValue, "text")
    }
}
