// ---------------------------------------------------------------------------
// sampleData — SAMPLE rows for the Dashboard shell's tables (Live agents,
// Open PRs, Issues assigned). This unit validates page structure only; U4
// wires the real TanStack live-agents table from the activity snapshot, and
// U5 wires real `gh`-backed PR/issue tables. Nothing here is persisted or
// fetched — nothing outside this file may import it as a data source.
// ---------------------------------------------------------------------------

export type SampleAgentState = 'working' | 'permission' | 'finished'

export interface SampleAgentRow {
  state: SampleAgentState
  agent: string
  project: string
  doing: string
  model: string
  elapsed: string
}

export const SAMPLE_AGENT_ROWS: SampleAgentRow[] = [
  {
    state: 'permission',
    agent: 'staging',
    project: 'orpheus',
    doing: 'run the db migration and verify counts',
    model: 'Opus 4.8',
    elapsed: '4m 02s'
  },
  {
    state: 'working',
    agent: 'env-scaffold',
    project: 'orpheus-cli',
    doing: 'add test:db to the env-var scaffold',
    model: 'Sonnet 5',
    elapsed: '11m 38s'
  },
  {
    state: 'working',
    agent: 'title-cb',
    project: 'ghostty-surface',
    doing: 'wire setTitleCallback through NAPI',
    model: 'Opus 4.8',
    elapsed: '2m 09s'
  },
  {
    state: 'finished',
    agent: 'cask bump',
    project: 'homebrew-tap',
    doing: 'bump the cask to v0.5.2',
    model: 'Opus 4.8',
    elapsed: '4m ago · 2m12s'
  }
]

export type SampleCheckState = 'passing' | 'failing' | 'pending' | 'none'

export interface SamplePrRow {
  number: number
  title: string
  repo: string
  checks: SampleCheckState
  draft: boolean
  pushed: string
}

export const SAMPLE_PR_ROWS: SamplePrRow[] = [
  {
    number: 117,
    title: 'workspaceResources registry (MDB-5)',
    repo: 'orpheus',
    checks: 'failing',
    draft: false,
    pushed: '2m'
  },
  {
    number: 42,
    title: 'orpheus-cli review fixes',
    repo: 'orpheus-cli',
    checks: 'pending',
    draft: true,
    pushed: '28m'
  },
  {
    number: 105,
    title: 'per-hunk revert on working tree',
    repo: 'orpheus',
    checks: 'passing',
    draft: false,
    pushed: '1h'
  },
  {
    number: 9,
    title: 'cask template render',
    repo: 'homebrew-tap',
    checks: 'passing',
    draft: false,
    pushed: '3h'
  },
  {
    number: 88,
    title: 'native mount self-heal',
    repo: 'ghostty-surface',
    checks: 'none',
    draft: false,
    pushed: 'yesterday'
  }
]

export interface SampleLabel {
  name: string
  colorVar: string
}

export interface SampleIssueRow {
  number: number
  title: string
  repo: string
  labels: SampleLabel[]
  updated: string
}

export const SAMPLE_ISSUE_ROWS: SampleIssueRow[] = [
  {
    number: 91,
    title: 'design the Dashboard surface',
    repo: 'orpheus',
    labels: [{ name: 'design', colorVar: 'var(--color-chart-3)' }],
    updated: '10m'
  },
  {
    number: 84,
    title: 'pane setup cwd wrong on reopen',
    repo: 'orpheus',
    labels: [{ name: 'bug', colorVar: 'var(--color-chart-5)' }],
    updated: '1h'
  },
  {
    number: 77,
    title: 'cask 404 on brew upgrade',
    repo: 'homebrew-tap',
    labels: [
      { name: 'bug', colorVar: 'var(--color-chart-5)' },
      { name: 'release', colorVar: 'var(--color-accent)' }
    ],
    updated: 'yesterday'
  },
  {
    number: 69,
    title: 'stale layouts selection race',
    repo: 'orpheus',
    labels: [{ name: 'bug', colorVar: 'var(--color-chart-5)' }],
    updated: '2d'
  }
]
