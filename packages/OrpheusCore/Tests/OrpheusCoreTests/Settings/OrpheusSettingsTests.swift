import XCTest
import Foundation
@testable import OrpheusCore

final class OrpheusSettingsTests: XCTestCase {

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .prettyPrinted]
        return e
    }()
    private let decoder = JSONDecoder()

    // MARK: - defaultValue

    func testDefaultValueIsAllNilEmpty() {
        let d = OrpheusSettings.defaultValue
        XCTAssertNil(d.general.theme)
        XCTAssertNil(d.general.density)
        XCTAssertNil(d.terminal.defaultShell)
        XCTAssertNil(d.terminal.scrollbackLines)
        XCTAssertNil(d.terminal.colorScheme)
        XCTAssertNil(d.claude.binaryPath)
        XCTAssertNil(d.claude.defaultFlags)
        XCTAssertTrue(d.quickActions.isEmpty)
        XCTAssertNil(d.extra)
    }

    // MARK: - Empty JSON

    func testEmptyObjectDecodesToDefault() throws {
        let data = "{}".data(using: .utf8)!
        let settings = try decoder.decode(OrpheusSettings.self, from: data)
        XCTAssertEqual(settings, OrpheusSettings.defaultValue)
    }

    // MARK: - GeneralSettings round-trip

    func testGeneralSettingsRoundTrip() throws {
        var s = OrpheusSettings.defaultValue
        s.general = GeneralSettings(theme: .dark, density: .compact)
        let data = try encoder.encode(s)
        let decoded = try decoder.decode(OrpheusSettings.self, from: data)
        XCTAssertEqual(decoded.general.theme, .dark)
        XCTAssertEqual(decoded.general.density, .compact)
    }

    func testAllThemePreferences() throws {
        for theme in ThemePreference.allCases {
            var s = OrpheusSettings.defaultValue
            s.general.theme = theme
            let data = try encoder.encode(s)
            let decoded = try decoder.decode(OrpheusSettings.self, from: data)
            XCTAssertEqual(decoded.general.theme, theme, "theme \(theme) failed round-trip")
        }
    }

    func testAllDensities() throws {
        for density in Density.allCases {
            var s = OrpheusSettings.defaultValue
            s.general.density = density
            let data = try encoder.encode(s)
            let decoded = try decoder.decode(OrpheusSettings.self, from: data)
            XCTAssertEqual(decoded.general.density, density, "density \(density) failed round-trip")
        }
    }

    // MARK: - TerminalSettings round-trip

    func testTerminalSettingsRoundTrip() throws {
        var s = OrpheusSettings.defaultValue
        s.terminal = TerminalSettings(
            defaultShell: "/bin/zsh",
            scrollbackLines: 10_000,
            colorScheme: "solarized-dark"
        )
        let data = try encoder.encode(s)
        let decoded = try decoder.decode(OrpheusSettings.self, from: data)
        XCTAssertEqual(decoded.terminal.defaultShell, "/bin/zsh")
        XCTAssertEqual(decoded.terminal.scrollbackLines, 10_000)
        XCTAssertEqual(decoded.terminal.colorScheme, "solarized-dark")
    }

    // MARK: - ClaudeSettings round-trip

    func testClaudeSettingsRoundTrip() throws {
        var s = OrpheusSettings.defaultValue
        s.claude = ClaudeSettings(
            binaryPath: "/opt/homebrew/bin/claude",
            defaultFlags: ["--verbose", "--no-color"]
        )
        let data = try encoder.encode(s)
        let decoded = try decoder.decode(OrpheusSettings.self, from: data)
        XCTAssertEqual(decoded.claude.binaryPath, "/opt/homebrew/bin/claude")
        XCTAssertEqual(decoded.claude.defaultFlags, ["--verbose", "--no-color"])
    }

    // MARK: - QuickActionDef round-trip

    func testQuickActionDefRoundTrip() throws {
        let qa = QuickActionDef(
            id: "format-on-save",
            label: "Format",
            binding: "cmd+shift+f",
            command: "swiftformat .",
            cwd: .project,
            ord: 1
        )
        var s = OrpheusSettings.defaultValue
        s.quickActions = [qa]
        let data = try encoder.encode(s)
        let decoded = try decoder.decode(OrpheusSettings.self, from: data)
        XCTAssertEqual(decoded.quickActions.count, 1)
        let dqa = decoded.quickActions[0]
        XCTAssertEqual(dqa.id, "format-on-save")
        XCTAssertEqual(dqa.label, "Format")
        XCTAssertEqual(dqa.binding, "cmd+shift+f")
        XCTAssertEqual(dqa.command, "swiftformat .")
        XCTAssertEqual(dqa.cwd, .project)
        XCTAssertEqual(dqa.ord, 1)
    }

    func testQuickActionCWDVariants() throws {
        let cases: [QuickActionCWD] = [.project, .terminal, .custom("/tmp/workspace")]
        for cwd in cases {
            let qa = QuickActionDef(id: "qa-\(UUID())", label: "L", command: "echo hi", cwd: cwd)
            let data = try encoder.encode(qa)
            let decoded = try decoder.decode(QuickActionDef.self, from: data)
            XCTAssertEqual(decoded.cwd, cwd, "cwd \(cwd) failed round-trip")
        }
    }

    // MARK: - extra / forward-compat catch-all

    func testUnknownTopLevelKeyPreservedInExtra() throws {
        let json = """
        {
            "general": {},
            "terminal": {},
            "claude": {},
            "quickActions": [],
            "futureKey": "hello",
            "anotherFuture": 42
        }
        """
        let data = json.data(using: .utf8)!
        let settings = try decoder.decode(OrpheusSettings.self, from: data)
        guard case .object(let dict) = settings.extra else {
            XCTFail("extra should be .object")
            return
        }
        XCTAssertEqual(dict["futureKey"], .string("hello"))
        XCTAssertEqual(dict["anotherFuture"], .number(42))
    }

    func testExtraRoundTrips() throws {
        let json = """
        {
            "general": {},
            "terminal": {},
            "claude": {},
            "quickActions": [],
            "newSection": {"nested": true}
        }
        """
        let data = json.data(using: .utf8)!
        let settings = try decoder.decode(OrpheusSettings.self, from: data)
        // Re-encode and decode; the unknown key should survive.
        let reEncoded = try encoder.encode(settings)
        let reDecoded = try decoder.decode(OrpheusSettings.self, from: reEncoded)
        XCTAssertEqual(reDecoded.extra, settings.extra)
    }

    func testNoUnknownKeysProducesNilExtra() throws {
        let json = """
        {
            "general": {"theme": "dark"},
            "terminal": {},
            "claude": {},
            "quickActions": []
        }
        """
        let data = json.data(using: .utf8)!
        let settings = try decoder.decode(OrpheusSettings.self, from: data)
        XCTAssertNil(settings.extra)
    }

    // MARK: - JSONValue round-trip

    func testJSONValueNull() throws {
        let v = JSONValue.null
        let data = try encoder.encode(v)
        let decoded = try decoder.decode(JSONValue.self, from: data)
        XCTAssertEqual(decoded, v)
    }

    func testJSONValueBool() throws {
        for b in [true, false] {
            let v = JSONValue.bool(b)
            let data = try encoder.encode(v)
            let decoded = try decoder.decode(JSONValue.self, from: data)
            XCTAssertEqual(decoded, v)
        }
    }

    func testJSONValueNumber() throws {
        let v = JSONValue.number(3.14)
        let data = try encoder.encode(v)
        let decoded = try decoder.decode(JSONValue.self, from: data)
        XCTAssertEqual(decoded, v)
    }

    func testJSONValueString() throws {
        let v = JSONValue.string("hello")
        let data = try encoder.encode(v)
        let decoded = try decoder.decode(JSONValue.self, from: data)
        XCTAssertEqual(decoded, v)
    }

    func testJSONValueArray() throws {
        let v = JSONValue.array([.number(1), .string("two"), .bool(false)])
        let data = try encoder.encode(v)
        let decoded = try decoder.decode(JSONValue.self, from: data)
        XCTAssertEqual(decoded, v)
    }

    func testJSONValueObject() throws {
        let v = JSONValue.object(["key": .string("value"), "n": .number(99)])
        let data = try encoder.encode(v)
        let decoded = try decoder.decode(JSONValue.self, from: data)
        XCTAssertEqual(decoded, v)
    }

    // MARK: - Equatable

    func testEquatable() {
        let a = OrpheusSettings.defaultValue
        var b = OrpheusSettings.defaultValue
        XCTAssertEqual(a, b)
        b.general.theme = .light
        XCTAssertNotEqual(a, b)
    }
}
