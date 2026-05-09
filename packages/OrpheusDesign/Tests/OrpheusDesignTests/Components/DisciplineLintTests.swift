import XCTest
@testable import OrpheusDesign

/// Compile-time-friendly lint that fails if any user-facing component file
/// references stock SwiftUI controls or raw values that should go through
/// the token system.
///
/// This is a coarse string scan — it can't catch every smuggled call, but
/// it catches the obvious slips and makes the discipline rule reviewable
/// in CI rather than only at PR time. False positives can be silenced by
/// adding `// orpheus-allow:<rule>` on the same line as the match.
final class DisciplineLintTests: XCTestCase {

    private static let scanDirs: [URL] = {
        let packageRoot = URL(fileURLWithPath: #file)
            .deletingLastPathComponent()      // .../Components
            .deletingLastPathComponent()      // .../OrpheusDesignTests
            .deletingLastPathComponent()      // .../Tests
            .deletingLastPathComponent()      // package root
        return [
            packageRoot.appendingPathComponent("Sources/OrpheusDesign/Components"),
            packageRoot.appendingPathComponent("Sources/OrpheusDesignCatalog")
        ]
    }()

    func testNoStockToggle() {
        scan(forbidden: #"\bToggle\("#, rule: "stock-toggle")
    }

    func testNoStockTextField() {
        // SwiftUI TextField init taking string + binding. NSTextField
        // wrapped via NSViewRepresentable is fine and uses NSTextField,
        // not TextField, so this pattern is precise.
        scan(forbidden: #"\bTextField\("#, rule: "stock-textfield")
    }

    func testNoStockTextEditor() {
        scan(forbidden: #"\bTextEditor\("#, rule: "stock-texteditor")
    }

    func testNoStockList() {
        // SwiftUI List ctor — `OrpheusList` is fine, but bare `List(`
        // (after a non-word boundary) means stock List.
        scan(forbidden: #"(?<![A-Za-z_])List\("#, rule: "stock-list")
    }

    func testNoStockMenu() {
        // SwiftUI Menu — `OrpheusMenu` and `.menu` material are fine.
        scan(forbidden: #"(?<![A-Za-z_])Menu\("#, rule: "stock-menu")
    }

    func testNoStockForm() {
        scan(forbidden: #"(?<![A-Za-z_])Form\("#, rule: "stock-form")
    }

    func testNoNavigationStack() {
        scan(forbidden: #"NavigationStack\b"#, rule: "navigation-stack")
    }

    func testNoNavigationSplitView() {
        scan(forbidden: #"NavigationSplitView\b"#, rule: "navigation-split-view")
    }

    func testNoTabView() {
        scan(forbidden: #"TabView\b"#, rule: "tab-view")
    }

    func testNoStockMaterialModifiers() {
        // `.regularMaterial`, `.thinMaterial`, etc. — go through
        // `OrpheusMaterial.<token>` instead.
        scan(forbidden: #"\.\b(?:ultraThinMaterial|thinMaterial|regularMaterial|thickMaterial|ultraThickMaterial)\b"#,
             rule: "stock-material")
    }

    func testNoColorWhiteBlackBlue() {
        // Color.white / .black / .blue etc. — go through OrpheusColor.
        // .clear is allowed (it's a no-paint, not a hue choice).
        scan(forbidden: #"Color\.\b(?:white|black|blue|red|green|yellow|orange|purple|pink|gray|brown|cyan|teal|mint|indigo)\b"#,
             rule: "stock-color")
    }

    func testNoSystemFont() {
        // .font(.system(...)) — go through OrpheusTypography / .orpheusFont.
        scan(forbidden: #"Font\.system\("#, rule: "system-font")
    }

    // MARK: -

    private func scan(forbidden pattern: String, rule: String,
                      file: StaticString = #filePath, line: UInt = #line) {
        let regex: NSRegularExpression
        do {
            regex = try NSRegularExpression(pattern: pattern)
        } catch {
            return XCTFail("invalid regex \(pattern): \(error)", file: file, line: line)
        }

        let fileManager = FileManager.default
        var violations: [String] = []
        for dir in Self.scanDirs {
            guard let enumerator = fileManager.enumerator(
                at: dir,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
            ) else { return XCTFail("Scan dir missing: \(dir.path)", file: file, line: line) }

            for case let url as URL in enumerator where url.pathExtension == "swift" {
                guard let body = try? String(contentsOf: url, encoding: .utf8) else { continue }
                let lines = body.components(separatedBy: "\n")
                for (index, raw) in lines.enumerated() {
                    let line = raw
                    if line.contains("orpheus-allow:\(rule)") { continue }
                    let nsLine = line as NSString
                    let range = NSRange(location: 0, length: nsLine.length)
                    if regex.firstMatch(in: line, options: [], range: range) != nil {
                        violations.append("\(url.lastPathComponent):\(index + 1): \(line.trimmingCharacters(in: .whitespaces))")
                    }
                }
            }
        }

        XCTAssertTrue(
            violations.isEmpty,
            "Discipline rule \(rule) violated. Either replace with the token equivalent or add `// orpheus-allow:\(rule)` on the same line.\n  - " +
            violations.joined(separator: "\n  - "),
            file: file, line: line
        )
    }
}
