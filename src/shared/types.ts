export type ExistingProject = {
  encodedName: string // e.g. "-Users-maverick-code-projects-orpheus"
  path: string // decoded absolute path, e.g. "/Users/maverick/code/projects/orpheus"
  name: string // basename, e.g. "orpheus"
  sessionCount: number // number of .jsonl files inside the dir
  lastActivity: number | null // ms timestamp of most recent .jsonl mtime, or null
}

export type DoctorResult = {
  claudeInstalled: boolean
  claudeVersion: string | null // e.g. "1.2.3" extracted from `claude --version`
  claudePath: string | null // e.g. "/usr/local/bin/claude"
  existingProjects: ExistingProject[]
}
