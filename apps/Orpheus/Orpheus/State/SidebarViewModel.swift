import Foundation
import Observation
import OrpheusCore

/// Selection state for the sidebar.
enum SidebarSelection: Equatable, Hashable {
    case dashboard
    case sessions
    case project(ProjectID)
    case space(SpaceID)
}

/// View model for the sidebar tree. Subscribes to repository streams and
/// exposes a flat, observable data model that `SidebarView` renders.
@Observable
@MainActor
final class SidebarViewModel {

    // MARK: - Observed state

    var projects: [Project] = []
    var spacesByProject: [ProjectID: [Space]] = [:]
    var terminalCountBySpace: [SpaceID: Int] = [:]
    var expandedProjects: Set<ProjectID> = []
    var selectedItem: SidebarSelection = .dashboard

    // MARK: - Deps + tasks

    let projectRepository: ProjectRepository
    let spaceRepository: SpaceRepository
    private let terminalRepository: TerminalRepository

    private var projectsTask: Task<Void, Never>?
    private var spaceTasks: [ProjectID: Task<Void, Never>] = [:]
    private var terminalTasks: [SpaceID: Task<Void, Never>] = [:]

    // MARK: - Init

    init(
        projectRepository: ProjectRepository,
        spaceRepository: SpaceRepository,
        terminalRepository: TerminalRepository
    ) {
        self.projectRepository = projectRepository
        self.spaceRepository = spaceRepository
        self.terminalRepository = terminalRepository
    }

    // MARK: - Start

    func start() {
        projectsTask?.cancel()
        projectsTask = Task { [weak self] in
            guard let self else { return }
            for await snapshot in await projectRepository.observeAll() {
                guard !Task.isCancelled else { return }
                self.projects = snapshot

                // Lazily subscribe to spaces for expanded projects
                for project in snapshot where self.expandedProjects.contains(project.id) {
                    if self.spaceTasks[project.id] == nil {
                        self.subscribeToSpaces(for: project.id)
                    }
                }
            }
        }
    }

    // Tasks are cancelled via the cleanup() method, which the owner calls
    // before releasing the view model. deinit cannot access @MainActor
    // properties in Swift concurrency, so we don't cancel here.
    func cleanup() {
        projectsTask?.cancel()
        projectsTask = nil
        for task in spaceTasks.values { task.cancel() }
        spaceTasks = [:]
        for task in terminalTasks.values { task.cancel() }
        terminalTasks = [:]
    }

    // MARK: - Expand / collapse

    func expand(_ projectID: ProjectID) {
        expandedProjects.insert(projectID)
        if spaceTasks[projectID] == nil {
            subscribeToSpaces(for: projectID)
        }
    }

    func collapse(_ projectID: ProjectID) {
        expandedProjects.remove(projectID)
        spaceTasks[projectID]?.cancel()
        spaceTasks[projectID] = nil

        // Tear down terminal subscriptions for spaces of this project
        if let spaces = spacesByProject[projectID] {
            for space in spaces {
                terminalTasks[space.id]?.cancel()
                terminalTasks[space.id] = nil
                terminalCountBySpace.removeValue(forKey: space.id)
            }
        }
        spacesByProject.removeValue(forKey: projectID)
    }

    func toggleExpand(_ projectID: ProjectID) {
        if expandedProjects.contains(projectID) {
            collapse(projectID)
        } else {
            expand(projectID)
        }
    }

    // MARK: - Selection

    func select(_ item: SidebarSelection) {
        selectedItem = item
    }

    // MARK: - Add project (write-through)

    /// Creates a project + Default Space. Returns the `SpaceID` of the Default Space.
    func addProject(name: String, rootPath: String) async throws -> SpaceID {
        let project = Project(name: name, rootPath: rootPath)
        try await projectRepository.create(project)

        // Create Default Space
        let space = Space(
            projectID: project.id,
            name: "Default Space",
            layoutSpec: .canvas([]),
            ord: 0
        )
        try await spaceRepository.create(space)
        return space.id
    }

    // MARK: - Logo glyph helper

    /// Returns `true` if the project's `rootPath` contains a `.git` directory.
    func isGitProject(_ project: Project) -> Bool {
        let gitPath = URL(fileURLWithPath: project.rootPath)
            .appendingPathComponent(".git")
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(
            atPath: gitPath.path,
            isDirectory: &isDir
        ) && isDir.boolValue
    }

    // MARK: - Pinned helpers

    var pinnedProjects: [Project] {
        projects.filter { $0.lifecycleState == .pinned }
            .sorted { $0.createdAt < $1.createdAt }
    }

    var unpinnedProjects: [Project] {
        projects.filter { $0.lifecycleState != .pinned && $0.lifecycleState != .archived }
            .sorted { $0.createdAt < $1.createdAt }
    }

    // MARK: - Space count for sidebar badge

    func spaceCount(for projectID: ProjectID) -> Int {
        spacesByProject[projectID]?.count ?? 0
    }

    // MARK: - Private subscription helpers

    private func subscribeToSpaces(for projectID: ProjectID) {
        let task = Task { [weak self] in
            guard let self else { return }
            for await snapshot in await spaceRepository.observeByProject(projectID) {
                guard !Task.isCancelled else { return }
                self.spacesByProject[projectID] = snapshot

                // Subscribe to terminals for each space
                for space in snapshot where self.terminalTasks[space.id] == nil {
                    self.subscribeToTerminals(for: space.id)
                }

                // Tear down terminal tasks for removed spaces
                let currentSpaceIDs = Set(snapshot.map(\.id))
                for (sid, task) in self.terminalTasks {
                    let spacesBelongToProject = self.spacesByProject[projectID]?.map(\.id) ?? []
                    if spacesBelongToProject.contains(sid) && !currentSpaceIDs.contains(sid) {
                        task.cancel()
                        self.terminalTasks.removeValue(forKey: sid)
                        self.terminalCountBySpace.removeValue(forKey: sid)
                    }
                }
            }
        }
        spaceTasks[projectID] = task
    }

    private func subscribeToTerminals(for spaceID: SpaceID) {
        let task = Task { [weak self] in
            guard let self else { return }
            for await snapshot in await terminalRepository.observeBySpace(spaceID) {
                guard !Task.isCancelled else { return }
                self.terminalCountBySpace[spaceID] = snapshot.count
            }
        }
        terminalTasks[spaceID] = task
    }
}
