import XCTest
import Foundation

/// Source-scanning lint tests for OrpheusTerminal discipline rules.
///
/// Each test walks the Swift source tree and fails on any line that matches
/// a forbidden pattern. Add `// orpheus-allow:<rule-name>` on the same line
/// to exempt a specific occurrence.
///
/// These tests have no module dependency — they scan the filesystem directly.
/// They run in < 1 second and enforce Phase 2A's hard discipline rules.
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
        packageRoot.appendingPathComponent("Sources/OrpheusTerminal")
    }

    private var smokeRoot: URL {
        packageRoot.appendingPathComponent("Sources/OrpheusTerminalSmoke")
    }

    // MARK: - Tests

    /// `import OrpheusCore` is forbidden in `Sources/OrpheusTerminal/`.
    /// Composition with OrpheusCore happens in Phase 2C's app target.
    func testNoOrpheusCoreImport() throws {
        var violations: [String] = []

        try walk(sourcesRoot) { url, line, lineNumber in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("import OrpheusCore")
                && !line.contains("orpheus-allow:orpheus-core-import") {
                violations.append("\(url.lastPathComponent):\(lineNumber) — \(trimmed)")
            }
        }

        XCTAssertTrue(
            violations.isEmpty,
            "Discipline rule orpheus-core-import violated in Sources/OrpheusTerminal/. "
            + "OrpheusTerminal does not depend on OrpheusCore. "
            + "Composition happens in Phase 2C's app target.\n  - "
            + violations.joined(separator: "\n  - ")
        )
    }

    /// `print(` is forbidden in `Sources/OrpheusTerminal/`. Use `OrpheusTerminalLogger.<category>`.
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
            "Discipline rule print violated in Sources/OrpheusTerminal/. "
            + "Use OrpheusTerminalLogger.<category>(...) instead of print(). "
            + "Add `// orpheus-allow:print` to exempt a specific line.\n  - "
            + violations.joined(separator: "\n  - ")
        )
    }

    /// Hardcoded `/Users/` paths are forbidden in `Sources/OrpheusTerminal/`.
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
                    break
                }
            }
        }

        XCTAssertTrue(
            violations.isEmpty,
            "Discipline rule user-path violated in Sources/OrpheusTerminal/. "
            + "Derive paths via FileManager.default.homeDirectoryForCurrentUser "
            + "or accept via injection.\n  - "
            + violations.joined(separator: "\n  - ")
        )
    }

    /// SwiftPM flattens all `.swift` sources into a single namespace, so two files
    /// with the same basename in different subdirectories will conflict at build time.
    func testNoBasenameCollisions() throws {
        let allRoots: [URL] = [sourcesRoot, smokeRoot]
        var seen: [String: String] = [:]
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

    /// Sanity check: `Sources/OrpheusTerminalSmoke/` MUST contain at least one
    /// `print(` call. If this fails, the smoke executable has stopped printing.
    func testSmokeIsTheOnlyPrintCaller() throws {
        var smokeHasPrint = false

        try walk(smokeRoot) { _, line, _ in
            if line.contains("print(") {
                smokeHasPrint = true
            }
        }

        XCTAssertTrue(
            smokeHasPrint,
            "Sources/OrpheusTerminalSmoke/ contains no `print(` calls. "
            + "The smoke executable must print boot diagnostics. "
            + "If the smoke stage was rewritten to use a logger, update this test."
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
