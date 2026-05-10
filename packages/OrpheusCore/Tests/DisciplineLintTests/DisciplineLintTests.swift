import XCTest
import Foundation

/// Source-scanning lint tests for OrpheusCore discipline rules.
///
/// Each test walks the Swift source tree and fails on any line that matches
/// a forbidden pattern. Add `// orpheus-allow:<rule-name>` on the same line
/// to exempt a specific occurrence.
///
/// These tests have no module dependency — they scan the filesystem directly.
/// They run in < 1 second and enforce Phase 1's hard discipline rules.
final class DisciplineLintTests: XCTestCase {

    // MARK: - Roots

    private var packageRoot: URL {
        // Tests/DisciplineLintTests/DisciplineLintTests.swift
        URL(fileURLWithPath: #file)
            .deletingLastPathComponent()   // DisciplineLintTests/
            .deletingLastPathComponent()   // Tests/
            .deletingLastPathComponent()   // package root
    }

    private var sourcesRoot: URL {
        packageRoot.appendingPathComponent("Sources/OrpheusCore")
    }

    private var smokeRoot: URL {
        packageRoot.appendingPathComponent("Sources/OrpheusCoreSmoke")
    }

    // MARK: - Tests

    /// `import SwiftUI`, `import AppKit`, `import OrpheusDesign`, `import Cocoa`
    /// are forbidden in `Sources/OrpheusCore/`.
    func testNoForbiddenUIImports() throws {
        let forbidden = [
            "import SwiftUI",
            "import AppKit",
            "import OrpheusDesign",
            "import Cocoa",
        ]
        var violations: [String] = []

        try walk(sourcesRoot) { url, line, lineNumber in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            for pattern in forbidden {
                if trimmed.hasPrefix(pattern)
                    && !line.contains("orpheus-allow:ui-imports") {
                    violations.append("\(url.lastPathComponent):\(lineNumber) — \(trimmed)")
                }
            }
        }

        XCTAssertTrue(
            violations.isEmpty,
            "Discipline rule ui-imports violated in Sources/OrpheusCore/. "
            + "Replace with Foundation / system-framework equivalents, or add "
            + "`// orpheus-allow:ui-imports` on the same line.\n  - "
            + violations.joined(separator: "\n  - ")
        )
    }

    /// `print(` is forbidden in `Sources/OrpheusCore/`. Use `OrpheusLogger.<category>`.
    /// Exempt lines with `// orpheus-allow:print`.
    func testNoPrintInLibrary() throws {
        var violations: [String] = []

        try walk(sourcesRoot) { url, line, lineNumber in
            if line.contains("print(")
                && !line.contains("orpheus-allow:print") {
                violations.append(
                    "\(url.lastPathComponent):\(lineNumber) — "
                    + line.trimmingCharacters(in: .whitespaces)
                )
            }
        }

        XCTAssertTrue(
            violations.isEmpty,
            "Discipline rule print violated in Sources/OrpheusCore/. "
            + "Use OrpheusLogger.<category>(...) instead of print(). "
            + "Add `// orpheus-allow:print` to exempt a specific line.\n  - "
            + violations.joined(separator: "\n  - ")
        )
    }

    /// Hardcoded `/Users/` paths are forbidden in `Sources/OrpheusCore/`.
    /// Always derive paths via `FileManager.default.homeDirectoryForCurrentUser`
    /// or accept them via injection.
    /// Exempt lines with `// orpheus-allow:user-path`.
    func testNoHardcodedUserPaths() throws {
        let patterns = [
            #"URL(fileURLWithPath: "/Users/"#,
            #""/Users/"#,
        ]
        var violations: [String] = []

        try walk(sourcesRoot) { url, line, lineNumber in
            guard !line.contains("orpheus-allow:user-path") else { return }
            for pattern in patterns {
                if line.contains(pattern) {
                    violations.append(
                        "\(url.lastPathComponent):\(lineNumber) — "
                        + line.trimmingCharacters(in: .whitespaces)
                    )
                    break   // report each line once even if both patterns match
                }
            }
        }

        XCTAssertTrue(
            violations.isEmpty,
            "Discipline rule user-path violated in Sources/OrpheusCore/. "
            + "Derive paths via FileManager.default.homeDirectoryForCurrentUser "
            + "or accept via injection. Add `// orpheus-allow:user-path` to exempt.\n  - "
            + violations.joined(separator: "\n  - ")
        )
    }

    /// SwiftPM flattens all `.swift` sources into a single namespace, so two files
    /// with the same basename in different subdirectories will conflict at build time.
    /// This test catches collisions before the compiler does.
    func testNoBasenameCollisions() throws {
        let allRoots: [URL] = [sourcesRoot, smokeRoot]
        var seen: [String: String] = [:]   // basename → first path seen
        var collisions: [String] = []

        for root in allRoots {
            guard let enumerator = FileManager.default.enumerator(
                at: root,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
            ) else {
                XCTFail("Cannot enumerate \(root.path)")
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
        }

        XCTAssertTrue(
            collisions.isEmpty,
            "SwiftPM basename collision detected — rename one of the files:\n  - "
            + collisions.joined(separator: "\n  - ")
        )
    }

    /// Sanity check: `Sources/OrpheusCoreSmoke/` MUST contain at least one
    /// `print(` call. If this test fails, the smoke executable has stopped
    /// printing, which likely means the rule in `testNoPrintInLibrary` is
    /// no longer exercised by real code.
    func testSmokeIsTheOnlyPrintCaller() throws {
        var smokeHasPrint = false

        try walk(smokeRoot) { _, line, _ in
            if line.contains("print(") {
                smokeHasPrint = true
            }
        }

        XCTAssertTrue(
            smokeHasPrint,
            "Sources/OrpheusCoreSmoke/ contains no `print(` calls. "
            + "The smoke executable must print its report. "
            + "If the smoke stage was rewritten to use a logger, update this test."
        )
    }

    // MARK: - Private helpers

    /// Walk all `.swift` files under `root` and call `visitor` for every line.
    ///
    /// - Parameters:
    ///   - root: Directory to walk recursively.
    ///   - visitor: Called with (fileURL, lineContent, 1-based line number).
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
