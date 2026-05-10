// OrpheusCoreSmoke — Phase 1 gate executable.
//
// Run:  swift run OrpheusCoreSmoke
//
// Each stage exercises one OrpheusCore subsystem against a fresh temp
// directory.  The report is a single-page "postcard" confirming all
// subsystems work end-to-end.

import Foundation
import OrpheusCore

// MARK: - Entry point

let timestamp = Int(Date().timeIntervalSince1970)
let packageRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let smokeRoot = packageRoot
    .appendingPathComponent(".smoke")
    .appendingPathComponent("\(timestamp)")

do {
    try FileManager.default.createDirectory(at: smokeRoot, withIntermediateDirectories: true)
} catch {
    print("ERROR: could not create temp dir \(smokeRoot.path): \(error)")
    Foundation.exit(1)
}

// Format today's date for the header.
let formatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    return f
}()
let dateString = formatter.string(from: Date())

print("=== Orpheus Phase 1 Smoke — \(dateString) ===")
print()

// MARK: - Stage 1: Persistence

print("[1/5] Persistence")
do {
    let dbURL = smokeRoot.appendingPathComponent("orpheus.db")
    let db = try await Database(path: dbURL.path)

    let projectRepo = ProjectRepository(database: db)
    let spaceRepo   = SpaceRepository(database: db)
    let termRepo    = TerminalRepository(database: db)

    // Insert 1 project.
    let project = Project(name: "Acme", rootPath: smokeRoot.path)
    try await projectRepo.create(project)

    // Insert 2 spaces.
    let spaceA = Space(
        projectID: project.id,
        name: "Default",
        layoutSpec: .canvas([]),
        ord: 0
    )
    let spaceB = Space(
        projectID: project.id,
        name: "Workshop",
        layoutSpec: .canvas([]),
        ord: 1
    )
    try await spaceRepo.create(spaceA)
    try await spaceRepo.create(spaceB)

    // Insert 3 terminals (2 in spaceA, 1 in spaceB).
    let termA1 = Terminal(spaceID: spaceA.id, cwd: "/tmp/a")
    let termA2 = Terminal(spaceID: spaceA.id, cwd: "/tmp/b")
    let termB1 = Terminal(spaceID: spaceB.id, cwd: "/tmp/c")
    try await termRepo.create(termA1)
    try await termRepo.create(termA2)
    try await termRepo.create(termB1)

    // Read back.
    let projects  = try await projectRepo.fetchAll()
    let spaces    = try await spaceRepo.fetchAll()
    let terminals = try await termRepo.fetchAll()

    let cwds = terminals.map(\.cwd).joined(separator: ", ")
    let spaceNames = spaces.map(\.name).joined(separator: ", ")

    print("  Project:   \"\(projects[0].name)\" (\(projects.count) row)")
    print("  Spaces:    \(spaceNames) (\(spaces.count) rows)")
    print("  Terminals: \(terminals.count) rows (cwd: \(cwds))")
} catch {
    print("  ERROR [Persistence]: \(error)")
    Foundation.exit(2)
}
print()

// MARK: - Stage 2: Settings

print("[2/5] Settings")
do {
    let globalURL  = smokeRoot.appendingPathComponent("global.json")
    let projectURL = smokeRoot.appendingPathComponent("project.json")

    let loader = SettingsLoader()
    let merger = SettingsMerger()

    // Write global: theme = dark.
    var globalSettings = OrpheusSettings.defaultValue
    globalSettings.general.theme = .dark
    try loader.write(globalSettings, to: globalURL)

    // Write project: scrollbackLines = 5000.
    var projectSettings = OrpheusSettings.defaultValue
    projectSettings.terminal.scrollbackLines = 5000
    try loader.write(projectSettings, to: projectURL)

    // Load + merge.
    let loadedGlobal  = try loader.loadGlobal(from: globalURL)
    let loadedProject = try loader.loadProject(from: projectURL)
    let merged = merger.merge(global: loadedGlobal, project: loadedProject)

    let globalTheme    = loadedGlobal.general.theme.map { $0.rawValue } ?? "nil"
    let projectScroll  = loadedProject.terminal.scrollbackLines.map { "\($0)" } ?? "nil"
    let mergedTheme    = merged.general.theme.map { $0.rawValue } ?? "nil"
    let mergedScroll   = merged.terminal.scrollbackLines.map { "\($0)" } ?? "nil"

    print("  global.theme         = \(globalTheme)")
    print("  project.scrollback   = \(projectScroll) (override)")
    print("  merged.theme         = \(mergedTheme)       <- from global")
    print("  merged.scrollback    = \(mergedScroll)    <- from project")
} catch {
    print("  ERROR [Settings]: \(error)")
    Foundation.exit(3)
}
print()

// MARK: - Stage 3: Sessions + Watcher

print("[3/5] Sessions")
do {
    let fixtureRoot = smokeRoot.appendingPathComponent(".claude/projects")
    try FileManager.default.createDirectory(at: fixtureRoot, withIntermediateDirectories: true)

    // Helper: write a JSONL session file.
    func writeSession(projectDir: String, sessionId: String, cwd: String) throws -> URL {
        let dir = fixtureRoot.appendingPathComponent(projectDir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("\(sessionId).jsonl")
        let headerDict: [String: Any] = [
            "sessionId": sessionId,
            "cwd": cwd,
            "gitBranch": "main"
        ]
        let headerData = try JSONSerialization.data(withJSONObject: headerDict)
        let headerLine = String(data: headerData, encoding: .utf8)!
        let lastDict: [String: Any] = [
            "lastUpdated": "2026-05-10T06:00:00.000Z",
            "type": "assistant"
        ]
        let lastData = try JSONSerialization.data(withJSONObject: lastDict)
        let lastLine = String(data: lastData, encoding: .utf8)!
        let content = headerLine + "\n" + lastLine + "\n"
        try content.data(using: .utf8)!.write(to: file, options: .atomic)
        return file
    }

    // Write the first session BEFORE start.
    try writeSession(projectDir: "encoded-cwd-1", sessionId: "sid-001", cwd: "/encoded-cwd-1")

    let registry = SessionRegistry(rootURL: fixtureRoot)

    // Subscribe BEFORE start so we catch the initial snapshot and watcher events.
    let updateStream = await registry.updates()
    try await registry.start()

    // Drain the initial scan emission(s) — expect exactly 1.
    let initialEvent = await firstValue(from: updateStream, timeout: 3.0)
    let initialSessionID: String
    if case .added(let m) = initialEvent {
        initialSessionID = m.sessionID.rawValue
    } else {
        initialSessionID = "(unknown)"
    }
    print("  Initial scan found 1 session: \(initialSessionID) at /encoded-cwd-1")

    // Give the watcher task a moment to arm itself.
    try await Task.sleep(nanoseconds: 600_000_000) // 600 ms

    // Write a second session while the watcher is live.
    let t0 = Date()
    try writeSession(projectDir: "encoded-cwd-2", sessionId: "sid-002", cwd: "/encoded-cwd-2")
    print("  Wrote second session: sid-002 at /encoded-cwd-2")

    // Wait for the watcher to emit an event (5 s timeout).
    let watcherEvent = await firstValue(from: updateStream, timeout: 5.0)
    let elapsed = String(format: "%.1f", Date().timeIntervalSince(t0))

    if let event = watcherEvent {
        let label: String
        switch event {
        case .added(let m):   label = ".added(\(m.sessionID.rawValue))"
        case .updated(let m): label = ".updated(\(m.sessionID.rawValue))"
        case .removed(let s): label = ".removed(\(s.rawValue))"
        }
        print("  Watcher emitted: \(label) (within \(elapsed) s)")
    } else {
        print("  WARNING: watcher did not emit within 5 s (timeout)")
    }

    let finalCount = await registry.recent(limit: 100).count
    print("  Final session count: \(finalCount)")
    await registry.stop()
} catch {
    print("  ERROR [Sessions]: \(error)")
    Foundation.exit(4)
}
print()

// MARK: - Stage 4: Subprocess

print("[4/5] Subprocess")
do {
    let manager = SubprocessManager()
    let result = try await manager.spawn(
        binaryPath: "/bin/echo",
        arguments: ["hello orpheus"],
        cwd: smokeRoot
    )

    // Collect stdout until EOF.
    var collectedData = Data()
    for await chunk in result.stdout {
        if chunk.isEmpty { break } // EOF sentinel
        collectedData.append(chunk)
    }
    let stdoutString = String(data: collectedData, encoding: .utf8) ?? "(non-UTF8)"

    // Drain events to get the exit status.
    var exitStatus: ExitStatus = .exit(0)
    for await event in result.events {
        if case .exited(_, let status) = event {
            exitStatus = status
            break
        }
    }

    let escapedOutput = stdoutString.replacingOccurrences(of: "\n", with: "\\n")
    print("  /bin/echo \"hello orpheus\" -> stdout: \"\(escapedOutput)\"")

    switch exitStatus {
    case .exit(let code):   print("  exit status: .exit(\(code))")
    case .signal(let sig):  print("  exit status: .signal(\(sig))")
    case .uncaughtException: print("  exit status: .uncaughtException")
    }

    // Optionally spawn `claude --version` if ORPHEUS_RUN_CLAUDE=1 and claude is on PATH.
    let runClaude = ProcessInfo.processInfo.environment["ORPHEUS_RUN_CLAUDE"] == "1"
    if runClaude {
        let resolver = ClaudeBinaryResolver()
        do {
            let claudePath = try await resolver.resolve()
            let claudeResult = try await manager.spawn(
                binaryPath: claudePath,
                arguments: ["--version"],
                cwd: smokeRoot
            )
            var claudeData = Data()
            for await chunk in claudeResult.stdout {
                if chunk.isEmpty { break }
                claudeData.append(chunk)
            }
            // Drain events.
            for await event in claudeResult.events {
                if case .exited = event { break }
            }
            let claudeOutput = String(data: claudeData, encoding: .utf8) ?? ""
            let firstLine = claudeOutput.components(separatedBy: "\n").first ?? ""
            print("  claude --version -> \(firstLine)")
        } catch {
            print("  claude not found on PATH: \(error)")
        }
    } else {
        print("  (claude integration skipped — set ORPHEUS_RUN_CLAUDE=1 to enable)")
    }
} catch {
    print("  ERROR [Subprocess]: \(error)")
    Foundation.exit(5)
}
print()

// MARK: - Stage 5: Cleanup report

print("[5/5] Cleanup")
print("  temp dir kept at: \(smokeRoot.path)")
print()
print("✓ all stages passed")

Foundation.exit(0)

// MARK: - Helpers

/// Await the first value from `stream`, returning nil if `timeout` seconds elapse first.
func firstValue<T: Sendable>(
    from stream: AsyncStream<T>,
    timeout: Double
) async -> T? {
    await withTaskGroup(of: T?.self) { group in
        group.addTask {
            for await value in stream { return value }
            return nil
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            return nil
        }
        let result = await group.next() ?? nil
        group.cancelAll()
        return result
    }
}
