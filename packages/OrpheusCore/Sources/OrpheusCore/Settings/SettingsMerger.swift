import Foundation

/// Merges a global and a per-project `OrpheusSettings` into a single resolved view.
///
/// **Merge rule:** project overrides global, field by field.
///
/// - Optional scalars: project value if non-nil; else global value.
/// - Arrays (`defaultFlags`, `quickActions`): project value if non-nil/non-empty;
///   else global value.  Arrays are **not** merged element-wise.
/// - Nested structs (`general`, `terminal`, `claude`): merged recursively,
///   field by field.
/// - `extra`: project's `extra` wins entirely if present; else global's.
public struct SettingsMerger: Sendable {

    public init() {}

    /// Produce the resolved settings by merging `project` on top of `global`.
    public func merge(global: OrpheusSettings, project: OrpheusSettings) -> OrpheusSettings {
        OrpheusSettings(
            general:      mergeGeneral(global: global.general, project: project.general),
            terminal:     mergeTerminal(global: global.terminal, project: project.terminal),
            claude:       mergeClaude(global: global.claude, project: project.claude),
            quickActions: project.quickActions.isEmpty ? global.quickActions : project.quickActions,
            extra:        project.extra ?? global.extra
        )
    }

    // MARK: - Section mergers

    private func mergeGeneral(global: GeneralSettings, project: GeneralSettings) -> GeneralSettings {
        GeneralSettings(
            theme:   project.theme   ?? global.theme,
            density: project.density ?? global.density
        )
    }

    private func mergeTerminal(global: TerminalSettings, project: TerminalSettings) -> TerminalSettings {
        TerminalSettings(
            defaultShell:   project.defaultShell   ?? global.defaultShell,
            scrollbackLines: project.scrollbackLines ?? global.scrollbackLines,
            colorScheme:    project.colorScheme    ?? global.colorScheme
        )
    }

    private func mergeClaude(global: ClaudeSettings, project: ClaudeSettings) -> ClaudeSettings {
        // defaultFlags: project wins if non-nil and non-empty; else global.
        let flags: [String]?
        if let pf = project.defaultFlags, !pf.isEmpty {
            flags = pf
        } else {
            flags = global.defaultFlags
        }
        return ClaudeSettings(
            binaryPath:   project.binaryPath ?? global.binaryPath,
            defaultFlags: flags
        )
    }
}
