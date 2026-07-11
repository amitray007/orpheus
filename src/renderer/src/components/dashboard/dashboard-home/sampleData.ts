// ---------------------------------------------------------------------------
// sampleData — SAMPLE rows for the Dashboard shell's REMAINING sample tables
// (Open PRs, Issues assigned). These are Phase 2 (`gh`-backed, U5) and stay
// sample until then. The Live-agents sample rows that used to live here
// (SAMPLE_AGENT_ROWS/SampleAgentRow/SampleAgentState) were REMOVED in U4 —
// LiveAgentsTable.tsx now renders real rows from useLiveAgents.ts. Nothing
// here is persisted or fetched — nothing outside this file may import it as
// a data source.
// ---------------------------------------------------------------------------

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
