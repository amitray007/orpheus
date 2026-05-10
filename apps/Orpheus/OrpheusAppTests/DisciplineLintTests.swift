import XCTest
import Foundation

/// Source-scanning lint tests for `apps/Orpheus/` discipline rules.
///
/// Mirrors the pattern from `packages/OrpheusCore/Tests/DisciplineLintTests/`.
/// Each test walks the Swift source tree and fails on any line matching a
/// forbidden pattern. Add `// orpheus-allow:<rule-name>` on the same line
/// to exempt a specific occurrence.
final class DisciplineLintTests: XCTestCase {

    // MARK: - Roots

    private var appSourceRoot: URL {
        // OrpheusAppTests/DisciplineLintTests.swift
        URL(fileURLWithPath: #file)
            .deletingLastPathComponent()   // OrpheusAppTests/
            .deletingLastPathComponent()   // apps/Orpheus/
            .appendingPathComponent("Orpheus")  // Orpheus/ (app target)
    }

    // MARK: - Tests

    /// `import OrpheusTerminal` is forbidden in Phase 2B.
    func testNoOrpheusTerminalImport() throws {
        var violations: [String] = []
        try walk(appSourceRoot) { url, line, lineNumber in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("import OrpheusTerminal")
                && !line.contains("orpheus-allow:terminal-import") {
                violations.append("\(url.lastPathComponent):\(lineNumber) — \(trimmed)")
            }
        }
        XCTAssertTrue(
            violations.isEmpty,
            "Phase 2B must not import OrpheusTerminal. Violations:\n  - "
            + violations.joined(separator: "\n  - ")
        )
    }

    /// Stock SwiftUI controls are forbidden in `Views/`.
    /// `List(`, `Toggle(`, `TextField(`, `Menu(`, `Form(`,
    /// `NavigationStack`, `NavigationSplitView`, `TabView`, `DisclosureGroup`
    /// — all must use OrpheusDesign equivalents.
    ///
    /// `Button(` is intentionally NOT in the array — SwiftUI APIs like
    /// `.alert { Button(...) }` legitimately require it. The
    /// `// orpheus-allow:stock-control` marker is honored on every line so
    /// tap-target-only `Button(action:) { }.buttonStyle(.plain)` wrappers can
    /// opt out per the discipline rules.
    func testNoStockSwiftUIControls() throws {
        let forbidden = [
            "NavigationStack",
            "NavigationSplitView",
            "TabView",
            "DisclosureGroup",
            "List {", "List(",
            "Toggle(",
            "TextField(",
            "Menu(",
            "Form(",
        ]
        var violations: [String] = []

        let viewsRoot = appSourceRoot.appendingPathComponent("Views")
        try walk(viewsRoot) { url, line, lineNumber in
            guard !line.contains("orpheus-allow:stock-control") else { return }
            for pattern in forbidden {
                if line.contains(pattern) {
                    violations.append("\(url.lastPathComponent):\(lineNumber) — \(line.trimmingCharacters(in: .whitespaces))")
                    break
                }
            }
        }

        XCTAssertTrue(
            violations.isEmpty,
            "Discipline rule stock-control violated in Views/. "
            + "Use OrpheusDesign equivalents or add `// orpheus-allow:stock-control`.\n  - "
            + violations.joined(separator: "\n  - ")
        )
    }

    /// Raw `Color.white`, `Color.black`, `Color.blue` etc. are forbidden.
    /// Must use `OrpheusColor.*` tokens.
    func testNoRawColors() throws {
        let patterns = [
            "Color.white", "Color.black", "Color.blue", "Color.red",
            "Color.green", "Color.gray", "Color.yellow", "Color.orange",
            "Color(red:", "Color(hue:",
        ]
        var violations: [String] = []

        try walk(appSourceRoot) { url, line, lineNumber in
            guard !line.contains("orpheus-allow:raw-color") else { return }
            for pattern in patterns {
                if line.contains(pattern) {
                    violations.append(
                        "\(url.lastPathComponent):\(lineNumber) — "
                        + line.trimmingCharacters(in: .whitespaces)
                    )
                    break
                }
            }
        }

        XCTAssertTrue(
            violations.isEmpty,
            "Discipline rule raw-color violated. Use OrpheusColor.* tokens.\n  - "
            + violations.joined(separator: "\n  - ")
        )
    }

    /// `.font(.system(` is forbidden. Must use `OrpheusTypography.*`.
    func testNoSystemFont() throws {
        var violations: [String] = []
        try walk(appSourceRoot) { url, line, lineNumber in
            if line.contains(".font(.system(") && !line.contains("orpheus-allow:system-font") {
                violations.append(
                    "\(url.lastPathComponent):\(lineNumber) — "
                    + line.trimmingCharacters(in: .whitespaces)
                )
            }
        }
        XCTAssertTrue(
            violations.isEmpty,
            "Discipline rule system-font violated. Use OrpheusTypography.*.\n  - "
            + violations.joined(separator: "\n  - ")
        )
    }

    /// Hardcoded `/Users/` paths are forbidden.
    func testNoHardcodedUserPaths() throws {
        let patterns = [#""/Users/"#, #"URL(fileURLWithPath: "/Users/"#]
        var violations: [String] = []

        try walk(appSourceRoot) { url, line, lineNumber in
            guard !line.contains("orpheus-allow:user-path") else { return }
            for pattern in patterns {
                if line.contains(pattern) {
                    violations.append(
                        "\(url.lastPathComponent):\(lineNumber) — "
                        + line.trimmingCharacters(in: .whitespaces)
                    )
                    break
                }
            }
        }

        XCTAssertTrue(
            violations.isEmpty,
            "Discipline rule user-path violated. Use FileManager APIs.\n  - "
            + violations.joined(separator: "\n  - ")
        )
    }

    /// `print(` is forbidden. Use `OrpheusAppLogger`.
    func testNoPrint() throws {
        var violations: [String] = []
        try walk(appSourceRoot) { url, line, lineNumber in
            if line.contains("print(") && !line.contains("orpheus-allow:print") {
                violations.append(
                    "\(url.lastPathComponent):\(lineNumber) — "
                    + line.trimmingCharacters(in: .whitespaces)
                )
            }
        }
        XCTAssertTrue(
            violations.isEmpty,
            "Discipline rule print violated. Use OrpheusAppLogger.\n  - "
            + violations.joined(separator: "\n  - ")
        )
    }

    /// No basename collisions across `apps/Orpheus/Orpheus/`.
    func testNoBasenameCollisions() throws {
        var seen: [String: String] = [:]
        var collisions: [String] = []

        try walk(appSourceRoot) { url, _, _ in
            // Only track on first line visit (file level, not per line)
        }

        // Re-walk at file level for collisions
        guard let enumerator = FileManager.default.enumerator(
            at: appSourceRoot,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            XCTFail("Cannot enumerate \(appSourceRoot.path)")
            return
        }

        for case let url as URL in enumerator where url.pathExtension == "swift" {
            let base = url.lastPathComponent
            if let prior = seen[base] {
                collisions.append("\(base): \(prior) vs \(url.path)")
            } else {
                seen[base] = url.path
            }
        }

        XCTAssertTrue(
            collisions.isEmpty,
            "SwiftPM basename collision detected — rename one of the files:\n  - "
            + collisions.joined(separator: "\n  - ")
        )
    }

    // MARK: - Private helpers

    private func walk(
        _ root: URL,
        visitor: (URL, String, Int) throws -> Void
    ) throws {
        guard let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            XCTFail("Cannot enumerate \(root.path)")
            return
        }

        for case let url as URL in enumerator where url.pathExtension == "swift" {
            guard let body = try? String(contentsOf: url, encoding: .utf8) else { continue }
            let lines = body.components(separatedBy: "\n")
            for (index, line) in lines.enumerated() {
                try visitor(url, line, index + 1)
            }
        }
    }
}
