import type React from 'react'
import type { ClaudeSubagent, ClaudeSubagentDraft } from '@shared/types'
import {
  FrontmatterCollectionSection,
  type FrontmatterCollectionConfig,
  type FormValues
} from './FrontmatterCollectionSection'

// ---------------------------------------------------------------------------
// ClaudeSubagentsSection — full CRUD for ~/.claude/agents/ and project .claude/agents/
//
// Thin configuration wrapper over FrontmatterCollectionSection. See that file
// for the shared editor behavior; this file only supplies what's specific to
// subagents: the CRUD quad, field schema (Model lives in row 1 alongside
// Source+Name; Tools gets its own full-width row), promoted keys, and copy.
// ---------------------------------------------------------------------------

// Keys already surfaced as named chips/fields
const PROMOTED_KEYS = new Set(['name', 'description', 'tools', 'model'])

function toolsToDraftValue(toolsRaw: string): string[] | null {
  return toolsRaw.trim()
    ? toolsRaw.split(',').flatMap((s) => {
        const v = s.trim()
        return v ? [v] : []
      })
    : null
}

const config: FrontmatterCollectionConfig<ClaudeSubagent, ClaudeSubagentDraft> = {
  idPrefix: 'agent',
  promotedKeys: PROMOTED_KEYS,
  fieldRows: [
    // Row 1 (alongside Source + Name, rendered by the generic form)
    [
      {
        key: 'model',
        label: 'Model',
        labelHint: '(empty = inherit)',
        type: 'text',
        placeholder: 'sonnet',
        widthClassName: 'w-36 flex-shrink-0',
        idSuffix: 'model'
      }
    ],
    // Row 2: Tools (own full-width row)
    [
      {
        key: 'toolsRaw',
        label: 'Tools',
        labelHint: '(comma-separated, empty = all tools)',
        type: 'text',
        placeholder: 'Bash, Read, Edit',
        idSuffix: 'tools'
      }
    ],
    // Row 3: Body
    [
      {
        key: 'body',
        label: 'Body / system prompt (markdown)',
        type: 'textarea',
        placeholder: 'You are a specialized subagent that…',
        rows: 10,
        monospace: true,
        idSuffix: 'body'
      }
    ]
  ],
  chips: [
    {
      render: (a) => a.model || null,
      monospace: true
    },
    {
      render: (a) => (a.tools ? `${a.tools.length} tool${a.tools.length !== 1 ? 's' : ''}` : null),
      title: (a) => a.tools?.join(', ')
    }
  ],
  copy: {
    title: 'Subagents',
    description: "Custom subagents from ~/.claude/agents/ and each project's .claude/agents/.",
    eyebrowLabel: 'Configured subagents',
    addButtonLabel: 'Add subagent',
    addButtonAriaLabel: 'Add subagent',
    formAriaLabel: 'Subagent',
    namePlaceholder: 'my-agent',
    descriptionPlaceholder: 'What this subagent specializes in…',
    emptyStateLine1: "No subagents found in ~/.claude/agents/ or any project's .claude/agents/",
    emptyStateLine2: 'Use "Add subagent" above to create one.',
    deleteTitle: 'Delete subagent?',
    deleteBodyText: 'This will permanently delete the subagent file.',
    userSourceLabel: 'User (~/.claude/agents)',
    userGroupLabel: 'User · ~/.claude/agents'
  },
  defaultValues: {
    name: '',
    description: '',
    toolsRaw: '',
    model: '',
    body: '',
    source: 'user',
    projectId: ''
  },
  toFormValues: (agent: ClaudeSubagent): FormValues => ({
    name: agent.name,
    description: agent.description ?? '',
    toolsRaw: agent.tools ? agent.tools.join(', ') : '',
    model: agent.model ?? '',
    body: agent.bodyPreview,
    source: agent.source,
    projectId: agent.projectId ?? ''
  }),
  toCreateDraft: (values: FormValues): ClaudeSubagentDraft => ({
    name: values.name.trim(),
    description: values.description.trim(),
    tools: toolsToDraftValue(values.toolsRaw),
    model: values.model.trim(),
    body: values.body,
    source: values.source === 'project' ? 'project' : 'user',
    projectId: values.source === 'project' ? values.projectId : undefined
  }),
  toUpdateDraft: (values: FormValues): Omit<ClaudeSubagentDraft, 'source' | 'projectId'> => ({
    name: values.name.trim(),
    description: values.description.trim(),
    tools: toolsToDraftValue(values.toolsRaw),
    model: values.model.trim(),
    body: values.body
  }),
  api: {
    list: () => window.api.claudeAgents.listSubagents(),
    add: (draft) => window.api.claudeAgents.addSubagent(draft),
    update: (path, draft) => window.api.claudeAgents.updateSubagent(path, draft),
    delete: (path) => window.api.claudeAgents.deleteSubagent(path)
  },
  logScope: 'subagents'
}

export function ClaudeSubagentsSection(): React.JSX.Element {
  return <FrontmatterCollectionSection config={config} />
}
