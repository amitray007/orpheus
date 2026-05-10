import XCTest
import Foundation
@testable import OrpheusCore

final class SettingsMergerTests: XCTestCase {

    private let merger = SettingsMerger()

    // MARK: - Helpers

    private func settings(
        theme: ThemePreference? = nil,
        density: Density? = nil,
        defaultShell: String? = nil,
        scrollbackLines: Int? = nil,
        colorScheme: String? = nil,
        binaryPath: String? = nil,
        defaultFlags: [String]? = nil,
        quickActions: [QuickActionDef] = [],
        extra: JSONValue? = nil
    ) -> OrpheusSettings {
        OrpheusSettings(
            general: GeneralSettings(theme: theme, density: density),
            terminal: TerminalSettings(
                defaultShell: defaultShell,
                scrollbackLines: scrollbackLines,
                colorScheme: colorScheme
            ),
            claude: ClaudeSettings(
                binaryPath: binaryPath,
                defaultFlags: defaultFlags
            ),
            quickActions: quickActions,
            extra: extra
        )
    }

    // MARK: - Global only

    func testGlobalOnlyPassesThrough() {
        let global = settings(
            theme: .dark,
            density: .compact,
            defaultShell: "/bin/bash",
            scrollbackLines: 5_000,
            colorScheme: "gruvbox",
            binaryPath: "/usr/bin/claude",
            defaultFlags: ["--verbose"]
        )
        let project = OrpheusSettings.defaultValue
        let merged = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.general.theme, .dark)
        XCTAssertEqual(merged.general.density, .compact)
        XCTAssertEqual(merged.terminal.defaultShell, "/bin/bash")
        XCTAssertEqual(merged.terminal.scrollbackLines, 5_000)
        XCTAssertEqual(merged.terminal.colorScheme, "gruvbox")
        XCTAssertEqual(merged.claude.binaryPath, "/usr/bin/claude")
        XCTAssertEqual(merged.claude.defaultFlags, ["--verbose"])
    }

    // MARK: - Project only

    func testProjectOnlyPassesThrough() {
        let global = OrpheusSettings.defaultValue
        let project = settings(
            theme: .light,
            density: .comfortable,
            defaultShell: "/bin/zsh",
            scrollbackLines: 1_000,
            colorScheme: "nord",
            binaryPath: "/opt/homebrew/bin/claude",
            defaultFlags: ["--bare"]
        )
        let merged = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.general.theme, .light)
        XCTAssertEqual(merged.general.density, .comfortable)
        XCTAssertEqual(merged.terminal.defaultShell, "/bin/zsh")
        XCTAssertEqual(merged.terminal.scrollbackLines, 1_000)
        XCTAssertEqual(merged.terminal.colorScheme, "nord")
        XCTAssertEqual(merged.claude.binaryPath, "/opt/homebrew/bin/claude")
        XCTAssertEqual(merged.claude.defaultFlags, ["--bare"])
    }

    // MARK: - Project overrides global, field by field

    func testProjectThemeOverridesGlobal() {
        let global  = settings(theme: .dark)
        let project = settings(theme: .light)
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.general.theme, .light)
    }

    func testProjectDensityOverridesGlobal() {
        let global  = settings(density: .comfortable)
        let project = settings(density: .compact)
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.general.density, .compact)
    }

    func testProjectShellOverridesGlobal() {
        let global  = settings(defaultShell: "/bin/bash")
        let project = settings(defaultShell: "/bin/fish")
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.terminal.defaultShell, "/bin/fish")
    }

    func testProjectScrollbackOverridesGlobal() {
        let global  = settings(scrollbackLines: 5_000)
        let project = settings(scrollbackLines: 200)
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.terminal.scrollbackLines, 200)
    }

    func testProjectColorSchemeOverridesGlobal() {
        let global  = settings(colorScheme: "solarized-dark")
        let project = settings(colorScheme: "dracula")
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.terminal.colorScheme, "dracula")
    }

    func testProjectBinaryPathOverridesGlobal() {
        let global  = settings(binaryPath: "/usr/bin/claude")
        let project = settings(binaryPath: "/opt/homebrew/bin/claude")
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.claude.binaryPath, "/opt/homebrew/bin/claude")
    }

    // MARK: - Per-field independence (set one field in project, keep others from global)

    func testProjectNilPreservesGlobal() {
        let global  = settings(theme: .dark, density: .compact)
        // Project only sets density; theme should come from global.
        let project = settings(theme: nil, density: .comfortable)
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.general.theme, .dark)      // from global
        XCTAssertEqual(merged.general.density, .comfortable) // from project
    }

    func testMixedTerminalFields() {
        let global  = settings(defaultShell: "/bin/bash", scrollbackLines: 5_000, colorScheme: "a")
        let project = settings(defaultShell: nil, scrollbackLines: 100, colorScheme: nil)
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.terminal.defaultShell, "/bin/bash") // global
        XCTAssertEqual(merged.terminal.scrollbackLines, 100)       // project
        XCTAssertEqual(merged.terminal.colorScheme, "a")           // global
    }

    // MARK: - Arrays

    func testProjectQuickActionsOverrideGlobal() {
        let qa1 = QuickActionDef(id: "g1", label: "Global", command: "echo g", cwd: .project)
        let qa2 = QuickActionDef(id: "p1", label: "Project", command: "echo p", cwd: .terminal)
        let global  = settings(quickActions: [qa1])
        let project = settings(quickActions: [qa2])
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.quickActions.count, 1)
        XCTAssertEqual(merged.quickActions[0].id, "p1")
    }

    func testEmptyProjectQuickActionsFallsBackToGlobal() {
        let qa = QuickActionDef(id: "g1", label: "Global", command: "echo g", cwd: .project)
        let global  = settings(quickActions: [qa])
        let project = settings(quickActions: [])  // empty → use global
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.quickActions.count, 1)
        XCTAssertEqual(merged.quickActions[0].id, "g1")
    }

    func testProjectDefaultFlagsOverrideGlobal() {
        let global  = settings(defaultFlags: ["--verbose"])
        let project = settings(defaultFlags: ["--bare", "--no-color"])
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.claude.defaultFlags, ["--bare", "--no-color"])
    }

    func testNilProjectDefaultFlagsFallsBackToGlobal() {
        let global  = settings(defaultFlags: ["--verbose"])
        let project = settings(defaultFlags: nil)
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.claude.defaultFlags, ["--verbose"])
    }

    func testEmptyProjectDefaultFlagsFallsBackToGlobal() {
        let global  = settings(defaultFlags: ["--verbose"])
        let project = settings(defaultFlags: [])  // empty → treat as "not set"
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.claude.defaultFlags, ["--verbose"])
    }

    // MARK: - extra

    func testProjectExtraWinsOverGlobal() {
        let global  = settings(extra: .string("global"))
        let project = settings(extra: .string("project"))
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.extra, .string("project"))
    }

    func testNilProjectExtraFallsBackToGlobalExtra() {
        let global  = settings(extra: .number(1))
        let project = settings(extra: nil)
        let merged  = merger.merge(global: global, project: project)
        XCTAssertEqual(merged.extra, .number(1))
    }

    func testBothNilExtraProducesNil() {
        let global  = settings()
        let project = settings()
        let merged  = merger.merge(global: global, project: project)
        XCTAssertNil(merged.extra)
    }

    // MARK: - Both all-nil

    func testMergeTwoDefaultsProducesDefault() {
        let merged = merger.merge(
            global: .defaultValue,
            project: .defaultValue
        )
        XCTAssertEqual(merged, OrpheusSettings.defaultValue)
    }
}
