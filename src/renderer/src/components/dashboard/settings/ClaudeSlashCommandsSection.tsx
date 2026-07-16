import type React from 'react'
import type { ClaudeSlashCommand, ClaudeSlashCommandDraft } from '@shared/types'
import {
  FrontmatterCollectionSection,
  type FrontmatterCollectionConfig,
  type FormValues
} from './FrontmatterCollectionSection'

// ---------------------------------------------------------------------------
// ClaudeSlashCommandsSection — full CRUD for ~/.claude/commands/ and project .claude/commands/
//
// Thin configuration wrapper over FrontmatterCollectionSection. See that file
// for the shared editor behavior; this file only supplies what's specific to
// slash commands: the CRUD quad, field schema (row 1 is Source+Name only;
// Argument hint + Allowed tools share a row), promoted keys, copy, and the
// '/' name prefix used throughout (visible name, aria-labels, delete modal).
// ---------------------------------------------------------------------------

// Keys already surfaced as named chips/fields — omit from the extra frontmatter grid to avoid redundancy
const PROMOTED_KEYS = new Set(['name', 'description', 'allowed-tools', 'argument-hint'])

function toolsToDraftValue(toolsRaw: string): string[] | null {
  return toolsRaw.trim()
    ? toolsRaw.split(',').flatMap((s) => {
        const v = s.trim()
        return v ? [v] : []
      })
    : null
}

const config: FrontmatterCollectionConfig<ClaudeSlashCommand, ClaudeSlashCommandDraft> = {
  idPrefix: 'cmd',
  promotedKeys: PROMOTED_KEYS,
  namePrefix: '/',
  fieldRows: [
    // Row 1: no extra fields beyond Source + Name.
    [],
    // Row 2: Argument hint + Allowed tools share a row.
    [
      {
        key: 'argumentHint',
        label: 'Argument hint',
        type: 'text',
        placeholder: '<file>',
        idSuffix: 'arg-hint'
      },
      {
        key: 'allowedToolsRaw',
        label: 'Allowed tools',
        labelHint: '(comma-separated)',
        type: 'text',
        placeholder: 'Bash, Read, Edit',
        idSuffix: 'tools'
      }
    ],
    // Row 3: Body
    [
      {
        key: 'body',
        label: 'Body (markdown)',
        type: 'textarea',
        placeholder: 'Command instructions…',
        rows: 10,
        monospace: true,
        idSuffix: 'body'
      }
    ]
  ],
  chips: [
    {
      render: (c) => c.argumentHint || null,
      monospace: true
    },
    {
      render: (c) =>
        c.allowedTools
          ? `${c.allowedTools.length} tool${c.allowedTools.length !== 1 ? 's' : ''}`
          : null,
      title: (c) => c.allowedTools?.join(', ')
    }
  ],
  copy: {
    title: 'Slash commands',
    description: "Custom commands from ~/.claude/commands/ and each project's .claude/commands/.",
    eyebrowLabel: 'Configured commands',
    addButtonLabel: 'Add command',
    addButtonAriaLabel: 'Add slash command',
    formAriaLabel: 'Slash command',
    namePlaceholder: 'my-command',
    descriptionPlaceholder: 'What this command does…',
    emptyStateLine1:
      "No slash commands found in ~/.claude/commands/ or any project's .claude/commands/",
    emptyStateLine2: 'Use "Add command" above to create one.',
    deleteTitle: 'Delete slash command?',
    deleteBodyText: 'This will permanently delete the command file.',
    userSourceLabel: 'User (~/.claude/commands)',
    userGroupLabel: 'User · ~/.claude/commands'
  },
  defaultValues: {
    name: '',
    description: '',
    allowedToolsRaw: '',
    argumentHint: '',
    body: '',
    source: 'user',
    projectId: ''
  },
  toFormValues: (cmd: ClaudeSlashCommand): FormValues => ({
    name: cmd.name,
    description: cmd.description ?? '',
    allowedToolsRaw: cmd.allowedTools ? cmd.allowedTools.join(', ') : '',
    argumentHint: cmd.argumentHint ?? '',
    body: cmd.bodyPreview, // bodyPreview has the full body (up to 600 chars)
    source: cmd.source,
    projectId: cmd.projectId ?? ''
  }),
  toCreateDraft: (values: FormValues): ClaudeSlashCommandDraft => ({
    name: values.name.trim(),
    description: values.description.trim(),
    allowedTools: toolsToDraftValue(values.allowedToolsRaw),
    argumentHint: values.argumentHint.trim(),
    body: values.body,
    source: values.source === 'project' ? 'project' : 'user',
    projectId: values.source === 'project' ? values.projectId : undefined
  }),
  toUpdateDraft: (values: FormValues): Omit<ClaudeSlashCommandDraft, 'source' | 'projectId'> => ({
    name: values.name.trim(),
    description: values.description.trim(),
    allowedTools: toolsToDraftValue(values.allowedToolsRaw),
    argumentHint: values.argumentHint.trim(),
    body: values.body
  }),
  api: {
    list: () => window.api.claudeAgents.listSlashCommands(),
    add: (draft) => window.api.claudeAgents.addSlashCommand(draft),
    update: (path, draft) => window.api.claudeAgents.updateSlashCommand(path, draft),
    delete: (path) => window.api.claudeAgents.deleteSlashCommand(path)
  },
  logScope: 'slash-commands'
}

export function ClaudeSlashCommandsSection(): React.JSX.Element {
  return <FrontmatterCollectionSection config={config} />
}
