import Foundation

/// App-level typed errors. Bridges `OrpheusCoreError` at the
/// call-site boundary so the app's error handling stays its own.
enum OrpheusAppError: LocalizedError {
    case databaseOpenFailed(reason: String)
    case windowSetupFailed(reason: String)
    case onboardingFailed(reason: String)
    case projectCreationFailed(reason: String)
    case settingsLoadFailed(reason: String)

    var errorDescription: String? {
        switch self {
        case .databaseOpenFailed(let reason):
            return "Database open failed: \(reason)"
        case .windowSetupFailed(let reason):
            return "Window setup failed: \(reason)"
        case .onboardingFailed(let reason):
            return "Onboarding failed: \(reason)"
        case .projectCreationFailed(let reason):
            return "Project creation failed: \(reason)"
        case .settingsLoadFailed(let reason):
            return "Settings load failed: \(reason)"
        }
    }
}
