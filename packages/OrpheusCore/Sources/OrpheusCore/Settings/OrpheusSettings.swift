import Foundation

// MARK: - Top-level settings struct

/// The fully typed, Codable representation of an Orpheus configuration file.
///
/// Both the global `~/.orpheus/config.json` and per-project
/// `<project-root>/.orpheus/config.json` decode into this type.
/// Unknown top-level keys are captured in `extra` for forward-compatibility.
public struct OrpheusSettings: Codable, Sendable, Equatable {
    public var general: GeneralSettings
    public var terminal: TerminalSettings
    public var claude: ClaudeSettings
    public var quickActions: [QuickActionDef]
    /// Forward-compat catch-all: any top-level JSON key not matched by the
    /// fields above is decoded into this value.  Round-trips transparently.
    public var extra: JSONValue?

    public init(
        general: GeneralSettings = .init(),
        terminal: TerminalSettings = .init(),
        claude: ClaudeSettings = .init(),
        quickActions: [QuickActionDef] = [],
        extra: JSONValue? = nil
    ) {
        self.general = general
        self.terminal = terminal
        self.claude = claude
        self.quickActions = quickActions
        self.extra = extra
    }

    /// An all-nil / all-empty settings object representing "nothing is set".
    /// Used as the default when a config file is absent.
    public static var defaultValue: OrpheusSettings {
        .init()
    }

    // MARK: - Custom Codable

    // The set of known top-level keys; used to identify unknown keys for `extra`.
    private static let knownKeys: Set<String> = ["general", "terminal", "claude", "quickActions"]

    private enum CodingKeys: String, CodingKey {
        case general, terminal, claude, quickActions
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        general     = try container.decodeIfPresent(GeneralSettings.self,  forKey: .general)      ?? .init()
        terminal    = try container.decodeIfPresent(TerminalSettings.self,  forKey: .terminal)     ?? .init()
        claude      = try container.decodeIfPresent(ClaudeSettings.self,    forKey: .claude)       ?? .init()
        quickActions = try container.decodeIfPresent([QuickActionDef].self, forKey: .quickActions) ?? []

        // Capture unknown top-level keys into `extra`.
        let dynamic = try decoder.container(keyedBy: DynamicKey.self)
        var unknown: [String: JSONValue] = [:]
        for key in dynamic.allKeys where !Self.knownKeys.contains(key.stringValue) {
            unknown[key.stringValue] = try dynamic.decode(JSONValue.self, forKey: key)
        }
        extra = unknown.isEmpty ? nil : .object(unknown)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(general,      forKey: .general)
        try container.encode(terminal,     forKey: .terminal)
        try container.encode(claude,       forKey: .claude)
        try container.encode(quickActions, forKey: .quickActions)

        // Re-emit unknown keys at the top level.
        if case .object(let dict) = extra {
            var dynamic = encoder.container(keyedBy: DynamicKey.self)
            for (k, v) in dict {
                try dynamic.encode(v, forKey: DynamicKey(k))
            }
        }
    }
}

/// A `CodingKey` that accepts any string value; used for forward-compat pass-through.
private struct DynamicKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ string: String) { self.stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

// MARK: - GeneralSettings

public struct GeneralSettings: Codable, Sendable, Equatable {
    /// `nil` means "inherit" (consumer decides the fallback).
    public var theme: ThemePreference?
    /// `nil` means "inherit".
    public var density: Density?

    public init(theme: ThemePreference? = nil, density: Density? = nil) {
        self.theme = theme
        self.density = density
    }
}

// MARK: - ThemePreference

public enum ThemePreference: String, Codable, Sendable, CaseIterable {
    case system
    case dark
    case light
}

// MARK: - Density

public enum Density: String, Codable, Sendable, CaseIterable {
    case compact
    case comfortable
}

// MARK: - TerminalSettings

public struct TerminalSettings: Codable, Sendable, Equatable {
    /// Path to the shell binary. `nil` = use system default.
    public var defaultShell: String?
    /// `nil` = use `ScrollbackConstants.scrollbackRingLimit` default.
    public var scrollbackLines: Int?
    /// Free-form name; the UI maps it to a known set.
    public var colorScheme: String?

    public init(
        defaultShell: String? = nil,
        scrollbackLines: Int? = nil,
        colorScheme: String? = nil
    ) {
        self.defaultShell = defaultShell
        self.scrollbackLines = scrollbackLines
        self.colorScheme = colorScheme
    }
}

// MARK: - ClaudeSettings

public struct ClaudeSettings: Codable, Sendable, Equatable {
    /// Override path for the claude binary. `nil` = `which claude`.
    public var binaryPath: String?
    /// Additional flags appended to every spawn. `nil` = none.
    public var defaultFlags: [String]?

    public init(binaryPath: String? = nil, defaultFlags: [String]? = nil) {
        self.binaryPath = binaryPath
        self.defaultFlags = defaultFlags
    }
}

// MARK: - QuickActionDef

public struct QuickActionDef: Codable, Sendable, Equatable, Identifiable {
    /// User-supplied stable id, e.g. `"format-on-save"`.
    public let id: String
    public var label: String
    /// Optional keyboard binding, e.g. `"cmd+shift+f"`.
    public var binding: String?
    /// Shell-quoted command to run.
    public var command: String
    public var cwd: QuickActionCWD
    /// Optional explicit ordering hint.
    public var ord: Int?

    public init(
        id: String,
        label: String,
        binding: String? = nil,
        command: String,
        cwd: QuickActionCWD,
        ord: Int? = nil
    ) {
        self.id = id
        self.label = label
        self.binding = binding
        self.command = command
        self.cwd = cwd
        self.ord = ord
    }
}

// MARK: - QuickActionCWD

/// The working directory context for a quick action.
public enum QuickActionCWD: Codable, Sendable, Equatable {
    case project
    case terminal
    case custom(String)

    // MARK: - Custom Codable

    private enum Tag: String, Codable {
        case project, terminal, custom
    }

    private enum CodingKeys: String, CodingKey {
        case tag, path
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let tag = try container.decode(Tag.self, forKey: .tag)
        switch tag {
        case .project:
            self = .project
        case .terminal:
            self = .terminal
        case .custom:
            let path = try container.decode(String.self, forKey: .path)
            self = .custom(path)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .project:
            try container.encode(Tag.project, forKey: .tag)
        case .terminal:
            try container.encode(Tag.terminal, forKey: .tag)
        case .custom(let path):
            try container.encode(Tag.custom, forKey: .tag)
            try container.encode(path, forKey: .path)
        }
    }
}

// MARK: - JSONValue

/// A self-describing JSON value for forward-compatibility catch-alls.
///
/// Round-trips arbitrary JSON transparently through encode/decode cycles.
public indirect enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    // MARK: - Codable

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let a = try? container.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "JSONValue: unrecognised JSON token"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let b):
            try container.encode(b)
        case .number(let n):
            try container.encode(n)
        case .string(let s):
            try container.encode(s)
        case .array(let a):
            try container.encode(a)
        case .object(let o):
            try container.encode(o)
        }
    }
}
