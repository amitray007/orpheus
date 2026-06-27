import type React from 'react'
import { useId } from 'react'
import type { ProjectRecord } from '@shared/types'
import { Select } from '../primitives'

// Matches the form label class used across the three CRUD settings sections.
const labelClass = 'block text-xs font-medium text-text-muted mb-1 uppercase tracking-wider'

export interface SourceSelectProps {
  /** User-facing label for the 'user' option — differs per entity type. */
  userLabel: string
  /** 'user', or the project ID when source is 'project'. */
  value: string
  projects: ProjectRecord[]
  onChange: (source: 'user' | 'project', projectId: string) => void
  disabled?: boolean
  autoFocus?: boolean
}

/**
 * Source-select field shared across the three CRUD settings sections
 * (subagents, slash commands, MCP servers). Renders the flex-1 wrapper div,
 * the labelled Source field, and the Select primitive. Callers own the
 * surrounding flex row.
 */
export function SourceSelect({
  userLabel,
  value,
  projects,
  onChange,
  disabled,
  autoFocus
}: SourceSelectProps): React.JSX.Element {
  const sourceId = useId()
  return (
    <div className="flex-1 min-w-0">
      <label htmlFor={sourceId} className={labelClass}>
        Source
      </label>
      <Select
        ariaLabel="Source"
        id={sourceId}
        disabled={disabled}
        autoFocus={autoFocus}
        value={value}
        onChange={(val) => {
          if (val === 'user') {
            onChange('user', '')
          } else {
            onChange('project', val)
          }
        }}
        options={[
          { value: 'user', label: userLabel },
          ...projects.map((p) => ({ value: p.id, label: `Project · ${p.name}` }))
        ]}
      />
    </div>
  )
}
