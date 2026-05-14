export type SectionId =
  | 'claude-general'
  | 'claude-display'
  | 'claude-permissions'
  | 'claude-auth'
  | 'claude-memory'
  | 'claude-tools'
  | 'claude-slash-commands'
  | 'claude-subagents'
  | 'claude-hooks'
  | 'claude-developer'
  | 'claude-about'
  | 'orpheus-appearance'
  | 'orpheus-sidebar'
  | 'orpheus-window'
  | 'orpheus-updates'
  | 'orpheus-developer'
  | 'orpheus-about'

export interface SettingsSearchEntry {
  sectionId: SectionId
  sectionGroup: 'Claude' | 'Orpheus'
  sectionLabel: string
  settingId: string
  label: string
  description?: string
  mapsTo: string[]
  keywords: string[]
}

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  // ---------------------------------------------------------------------------
  // Claude › General
  // ---------------------------------------------------------------------------
  {
    sectionId: 'claude-general',
    sectionGroup: 'Claude',
    sectionLabel: 'General',
    settingId: 'model',
    label: 'Model',
    description: 'Which Claude model launches by default.',
    mapsTo: ['--model', 'ANTHROPIC_MODEL'],
    keywords: ['claude model', 'engine', 'version', 'llm', 'ai model', 'sonnet', 'opus', 'haiku', 'default model']
  },
  {
    sectionId: 'claude-general',
    sectionGroup: 'Claude',
    sectionLabel: 'General',
    settingId: 'permission-mode',
    label: 'Permission mode',
    description: 'How claude handles tool-use permission requests.',
    mapsTo: ['--permission-mode'],
    keywords: ['auto-approve', 'perms', 'tool permissions', 'yolo', 'accept', 'bypass', 'plan mode', 'approve', 'safety']
  },
  {
    sectionId: 'claude-general',
    sectionGroup: 'Claude',
    sectionLabel: 'General',
    settingId: 'effort',
    label: 'Effort',
    description: 'Trade-off between speed and thoroughness.',
    mapsTo: ['--effort', 'CLAUDE_CODE_EFFORT_LEVEL'],
    keywords: ['speed', 'thoroughness', 'quality', 'effort level', 'thinking depth', 'low high max']
  },
  {
    sectionId: 'claude-general',
    sectionGroup: 'Claude',
    sectionLabel: 'General',
    settingId: 'auto-load-memory',
    label: 'Auto-load memory',
    description: 'Automatically include CLAUDE.md context files when claude starts.',
    mapsTo: ['CLAUDE_CODE_DISABLE_AUTO_MEMORY'],
    keywords: ['claude md', 'context files', 'memory files', 'project context', 'auto memory', 'disable memory']
  },
  {
    sectionId: 'claude-general',
    sectionGroup: 'Claude',
    sectionLabel: 'General',
    settingId: 'extended-thinking',
    label: 'Extended thinking',
    description: 'Always allow claude to think before responding. Slower but more thorough.',
    mapsTo: ['alwaysThinkingEnabled'],
    keywords: ['thinking', 'reasoning', 'slow response', 'deliberation', 'chain of thought', 'always think']
  },
  {
    sectionId: 'claude-general',
    sectionGroup: 'Claude',
    sectionLabel: 'General',
    settingId: 'fallback-model',
    label: 'Fallback model',
    description: 'Model used when the primary model is overloaded or unavailable.',
    mapsTo: ['--fallback-model'],
    keywords: ['backup model', 'overload', 'unavailable model', 'failover', 'alternate model']
  },
  {
    sectionId: 'claude-general',
    sectionGroup: 'Claude',
    sectionLabel: 'General',
    settingId: 'disable-extended-thinking',
    label: 'Disable extended thinking',
    description: 'Prevents Claude from using extended thinking even when effort is high.',
    mapsTo: ['CLAUDE_CODE_DISABLE_THINKING'],
    keywords: ['no thinking', 'disable think', 'fast response', 'no reasoning']
  },
  {
    sectionId: 'claude-general',
    sectionGroup: 'Claude',
    sectionLabel: 'General',
    settingId: 'disable-fast-mode',
    label: 'Disable fast mode',
    description: 'Forces Claude to skip the fast-response optimization path.',
    mapsTo: ['CLAUDE_CODE_DISABLE_FAST_MODE'],
    keywords: ['fast mode', 'optimization', 'response speed', 'slow mode']
  },
  {
    sectionId: 'claude-general',
    sectionGroup: 'Claude',
    sectionLabel: 'General',
    settingId: 'max-turns-per-session',
    label: 'Max turns per session',
    description: 'Hard cap on the number of agentic turns per session.',
    mapsTo: ['CLAUDE_CODE_MAX_TURNS'],
    keywords: ['turn limit', 'session limit', 'agentic turns', 'max iterations', 'loop limit']
  },
  {
    sectionId: 'claude-general',
    sectionGroup: 'Claude',
    sectionLabel: 'General',
    settingId: 'disable-1m-context',
    label: 'Disable 1M context',
    description: 'Prevent Claude from using the 1-million-token extended context window.',
    mapsTo: ['CLAUDE_CODE_DISABLE_1M_CONTEXT'],
    keywords: ['context window', 'token limit', '1 million tokens', 'long context', 'context size']
  },
  {
    sectionId: 'claude-general',
    sectionGroup: 'Claude',
    sectionLabel: 'General',
    settingId: 'disable-adaptive-thinking',
    label: 'Disable adaptive thinking',
    description: 'Turn off adaptive thinking optimizations that adjust reasoning depth based on prompt complexity.',
    mapsTo: ['CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING'],
    keywords: ['adaptive', 'reasoning depth', 'dynamic thinking', 'smart mode']
  },
  {
    sectionId: 'claude-general',
    sectionGroup: 'Claude',
    sectionLabel: 'General',
    settingId: 'disable-legacy-model-remap',
    label: 'Disable legacy model remap',
    description: 'Stop Claude from automatically remapping legacy model identifiers to their current equivalents.',
    mapsTo: ['CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP'],
    keywords: ['model alias', 'legacy model', 'model remap', 'model migration']
  },

  // ---------------------------------------------------------------------------
  // Claude › Display
  // ---------------------------------------------------------------------------
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'output-style',
    label: 'Output style',
    description: 'Influences how verbose and proactive Claude\'s responses are.',
    mapsTo: ['outputStyle'],
    keywords: ['verbosity', 'response style', 'explanatory', 'proactive', 'learning mode', 'response format']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'tui-renderer',
    label: 'TUI renderer',
    description: 'Whether Claude\'s terminal UI fills the pane or stays in a scrollable default view.',
    mapsTo: ['tui'],
    keywords: ['terminal ui', 'fullscreen', 'tui mode', 'scrollable', 'terminal view']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'editor-mode',
    label: 'Editor mode',
    description: 'Keybinding scheme for the Claude Code inline editor.',
    mapsTo: ['editorMode'],
    keywords: ['vim', 'keybindings', 'editor keybindings', 'vi mode', 'normal mode', 'key bindings']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'native-cursor',
    label: 'Native cursor',
    description: 'Use the system cursor style inside the embedded terminal instead of the block cursor.',
    mapsTo: ['CLAUDE_CODE_NATIVE_CURSOR'],
    keywords: ['cursor style', 'block cursor', 'system cursor', 'terminal cursor']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'hide-cwd-in-logo',
    label: 'Hide cwd in logo',
    description: 'Remove the current working directory line from Claude\'s session banner.',
    mapsTo: ['CLAUDE_CODE_HIDE_CWD'],
    keywords: ['working directory', 'cwd', 'banner', 'session header', 'hide path']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'reduce-motion',
    label: 'Reduce motion',
    description: 'Disables transitions and animations throughout the Orpheus UI.',
    mapsTo: ['prefersReducedMotion'],
    keywords: ['animations', 'transitions', 'accessibility', 'motion', 'no animation', 'a11y']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'no-flicker',
    label: 'No flicker',
    description: 'Reduce screen flicker on some terminal emulators.',
    mapsTo: ['CLAUDE_CODE_NO_FLICKER'],
    keywords: ['flicker', 'screen flicker', 'terminal flicker', 'rendering artifact']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'disable-alternate-screen',
    label: 'Disable alternate screen',
    description: 'Prevent Claude from switching to an alternate terminal screen buffer.',
    mapsTo: ['CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN'],
    keywords: ['alternate screen', 'terminal buffer', 'screen buffer', 'alt screen']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'disable-virtual-scroll',
    label: 'Disable virtual scroll',
    description: 'Turn off Claude\'s virtual scrolling implementation.',
    mapsTo: ['CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL'],
    keywords: ['virtual scroll', 'scrolling', 'scroll behavior']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'disable-mouse',
    label: 'Disable mouse',
    description: 'Disable mouse event handling inside Claude\'s terminal UI.',
    mapsTo: ['CLAUDE_CODE_DISABLE_MOUSE'],
    keywords: ['mouse events', 'mouse support', 'terminal mouse', 'click events']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'disable-terminal-title',
    label: 'Disable terminal title',
    description: 'Stop Claude from updating the terminal window title during sessions.',
    mapsTo: ['CLAUDE_CODE_DISABLE_TERMINAL_TITLE'],
    keywords: ['terminal title', 'window title', 'title bar', 'tab title']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'scroll-speed',
    label: 'Scroll speed (1–20)',
    description: 'Override the scroll speed inside Claude\'s TUI.',
    mapsTo: ['CLAUDE_CODE_SCROLL_SPEED'],
    keywords: ['scroll speed', 'scroll rate', 'terminal scroll', 'scrolling speed']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'code-accessibility',
    label: 'Code accessibility',
    description: 'Enable accessibility enhancements for code blocks in Claude\'s output.',
    mapsTo: ['CLAUDE_CODE_CODE_ACCESSIBILITY'],
    keywords: ['a11y', 'accessibility', 'code blocks', 'screen reader']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'omit-attribution-header',
    label: 'Omit attribution header',
    description: 'Remove the attribution block from the system prompt start.',
    mapsTo: ['CLAUDE_CODE_ATTRIBUTION_HEADER'],
    keywords: ['attribution', 'system prompt', 'header', 'prompt header']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'force-sync-output',
    label: 'Force sync output',
    description: 'Force all terminal output to be written synchronously.',
    mapsTo: ['CLAUDE_CODE_FORCE_SYNC_OUTPUT'],
    keywords: ['sync output', 'synchronous', 'output sync', 'terminal output']
  },
  {
    sectionId: 'claude-display',
    sectionGroup: 'Claude',
    sectionLabel: 'Display',
    settingId: 'enable-prompt-suggestion',
    label: 'Enable prompt suggestion',
    description: 'Show inline prompt suggestions inside the Claude input field.',
    mapsTo: ['CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION'],
    keywords: ['prompt suggestion', 'autocomplete', 'input suggestion', 'inline suggestion']
  },

  // ---------------------------------------------------------------------------
  // Claude › Permissions
  // ---------------------------------------------------------------------------
  {
    sectionId: 'claude-permissions',
    sectionGroup: 'Claude',
    sectionLabel: 'Permissions',
    settingId: 'auto-approve-file-edits',
    label: 'Auto-approve file edits',
    description: 'Adds "Edit" to the allow list at launch — claude may edit files without prompting.',
    mapsTo: ['permissions.allow[Edit]'],
    keywords: ['allow edits', 'file permission', 'edit permission', 'auto allow', 'approve edits']
  },
  {
    sectionId: 'claude-permissions',
    sectionGroup: 'Claude',
    sectionLabel: 'Permissions',
    settingId: 'ask-before-destructive-bash-commands',
    label: 'Ask before destructive Bash commands',
    description: 'Injects ask-rules for rm, git reset, force-push, DROP TABLE, and similar at launch.',
    mapsTo: ['permissions.ask[Bash(...)]'],
    keywords: ['destructive commands', 'rm', 'delete', 'dangerous bash', 'confirm', 'ask permission']
  },
  {
    sectionId: 'claude-permissions',
    sectionGroup: 'Claude',
    sectionLabel: 'Permissions',
    settingId: 'plan-mode-by-default',
    label: 'Plan mode by default',
    description: 'Sets --permission-mode plan at launch so Claude always produces a plan before executing.',
    mapsTo: ['--permission-mode plan'],
    keywords: ['plan first', 'planning mode', 'safe mode', 'review before execute']
  },
  {
    sectionId: 'claude-permissions',
    sectionGroup: 'Claude',
    sectionLabel: 'Permissions',
    settingId: 'allow-rules',
    label: 'Allow rules',
    description: 'Explicit allow-list rules for tool use.',
    mapsTo: ['permissions.allow'],
    keywords: ['allowlist', 'whitelist', 'allow rule', 'tool allow', 'permission rule']
  },
  {
    sectionId: 'claude-permissions',
    sectionGroup: 'Claude',
    sectionLabel: 'Permissions',
    settingId: 'ask-rules',
    label: 'Ask rules',
    description: 'Rules that trigger a confirmation prompt before tool use.',
    mapsTo: ['permissions.ask'],
    keywords: ['ask permission', 'confirm rule', 'prompt before', 'approval rule']
  },
  {
    sectionId: 'claude-permissions',
    sectionGroup: 'Claude',
    sectionLabel: 'Permissions',
    settingId: 'deny-rules',
    label: 'Deny rules',
    description: 'Rules that block specific tool use.',
    mapsTo: ['permissions.deny'],
    keywords: ['denylist', 'blacklist', 'block rule', 'deny permission', 'forbidden']
  },
  {
    sectionId: 'claude-permissions',
    sectionGroup: 'Claude',
    sectionLabel: 'Permissions',
    settingId: 'additional-directories',
    label: 'Additional directories',
    description: 'Extra directories Claude is allowed to access.',
    mapsTo: ['permissions.additionalDirectories'],
    keywords: ['allowed paths', 'directory access', 'file access', 'extra paths', 'folder permission']
  },

  // ---------------------------------------------------------------------------
  // Claude › Authentication
  // ---------------------------------------------------------------------------
  {
    sectionId: 'claude-auth',
    sectionGroup: 'Claude',
    sectionLabel: 'Authentication',
    settingId: 'provider',
    label: 'Provider',
    description: 'Which cloud backend Claude Code connects to.',
    mapsTo: [],
    keywords: ['cloud provider', 'anthropic', 'bedrock', 'vertex', 'foundry', 'backend', 'aws', 'gcp', 'azure']
  },
  {
    sectionId: 'claude-auth',
    sectionGroup: 'Claude',
    sectionLabel: 'Authentication',
    settingId: 'api-key',
    label: 'API key',
    description: 'Stored in the local Orpheus database.',
    mapsTo: ['ANTHROPIC_API_KEY'],
    keywords: ['anthropic key', 'auth', 'credential', 'secret', 'env key', 'api-key', 'sk-ant', 'token', 'auth key', 'api credential']
  },
  {
    sectionId: 'claude-auth',
    sectionGroup: 'Claude',
    sectionLabel: 'Authentication',
    settingId: 'verify',
    label: 'Verify',
    description: 'Hits Anthropic /v1/models with your stored key. No tokens are billed.',
    mapsTo: [],
    keywords: ['test connection', 'connection test', 'ping', 'verify key', 'check key', 'test api']
  },
  {
    sectionId: 'claude-auth',
    sectionGroup: 'Claude',
    sectionLabel: 'Authentication',
    settingId: 'base-url-override',
    label: 'Base URL override',
    description: 'Proxy or local model endpoint. Leave blank to use the provider default.',
    mapsTo: ['ANTHROPIC_BASE_URL'],
    keywords: ['proxy url', 'custom endpoint', 'base url', 'local model', 'api endpoint', 'override url']
  },
  {
    sectionId: 'claude-auth',
    sectionGroup: 'Claude',
    sectionLabel: 'Authentication',
    settingId: 'resource',
    label: 'Resource',
    description: 'Your Azure AI Foundry resource name.',
    mapsTo: ['ANTHROPIC_FOUNDRY_RESOURCE'],
    keywords: ['azure', 'foundry', 'resource name', 'ai foundry']
  },
  {
    sectionId: 'claude-auth',
    sectionGroup: 'Claude',
    sectionLabel: 'Authentication',
    settingId: 'aws-region',
    label: 'AWS region',
    description: 'Required for Bedrock. Example: us-east-1, eu-west-1.',
    mapsTo: ['AWS_REGION'],
    keywords: ['bedrock region', 'amazon region', 'aws bedrock', 'us-east', 'eu-west']
  },
  {
    sectionId: 'claude-auth',
    sectionGroup: 'Claude',
    sectionLabel: 'Authentication',
    settingId: 'aws-bearer-token',
    label: 'AWS bearer token (optional)',
    description: 'Alternative to IAM credentials. Sets AWS_BEARER_TOKEN_BEDROCK.',
    mapsTo: ['AWS_BEARER_TOKEN_BEDROCK'],
    keywords: ['bedrock token', 'iam', 'aws credentials', 'bearer token']
  },
  {
    sectionId: 'claude-auth',
    sectionGroup: 'Claude',
    sectionLabel: 'Authentication',
    settingId: 'gcp-project-id',
    label: 'GCP project ID',
    description: 'Required for Vertex. Your Google Cloud project ID.',
    mapsTo: ['ANTHROPIC_VERTEX_PROJECT_ID'],
    keywords: ['vertex', 'google cloud', 'gcp', 'project id', 'cloud project']
  },
  {
    sectionId: 'claude-auth',
    sectionGroup: 'Claude',
    sectionLabel: 'Authentication',
    settingId: 'region',
    label: 'Region',
    description: 'Required for Vertex. Example: us-east5, global, europe-west1.',
    mapsTo: ['CLOUD_ML_REGION'],
    keywords: ['vertex region', 'google region', 'cloud region', 'us-east5']
  },

  // ---------------------------------------------------------------------------
  // Claude › Memory & Context
  // ---------------------------------------------------------------------------
  {
    sectionId: 'claude-memory',
    sectionGroup: 'Claude',
    sectionLabel: 'Memory & Context',
    settingId: 'disable-git-instructions',
    label: 'Disable git instructions',
    description: 'Suppress the automatic git-context message that Claude prepends to sessions.',
    mapsTo: ['CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS'],
    keywords: ['git context', 'git message', 'suppress git', 'git header', 'session start']
  },
  {
    sectionId: 'claude-memory',
    sectionGroup: 'Claude',
    sectionLabel: 'Memory & Context',
    settingId: 'max-output-tokens',
    label: 'Max output tokens',
    description: 'Upper bound on tokens in a single Claude response.',
    mapsTo: ['CLAUDE_CODE_MAX_OUTPUT_TOKENS'],
    keywords: ['token limit', 'response length', 'output length', 'max tokens', 'token cap']
  },
  {
    sectionId: 'claude-memory',
    sectionGroup: 'Claude',
    sectionLabel: 'Memory & Context',
    settingId: 'max-context-tokens',
    label: 'Max context tokens',
    description: 'Cap on the total context window sent per turn.',
    mapsTo: ['CLAUDE_CODE_MAX_CONTEXT_TOKENS'],
    keywords: ['context limit', 'context cap', 'context window', 'window size', 'total tokens']
  },
  {
    sectionId: 'claude-memory',
    sectionGroup: 'Claude',
    sectionLabel: 'Memory & Context',
    settingId: 'compaction-threshold',
    label: 'Compaction threshold',
    description: 'Compact older context when usage exceeds this percentage.',
    mapsTo: ['CLAUDE_CODE_AUTO_COMPACT_THRESHOLD'],
    keywords: ['compact', 'compaction', 'context compression', 'memory compression', 'auto compact']
  },
  {
    sectionId: 'claude-memory',
    sectionGroup: 'Claude',
    sectionLabel: 'Memory & Context',
    settingId: 'max-thinking-tokens',
    label: 'Max thinking tokens',
    description: 'Upper bound on tokens used for extended thinking per response.',
    mapsTo: ['MAX_THINKING_TOKENS'],
    keywords: ['thinking tokens', 'thinking budget', 'reasoning tokens', 'think limit']
  },
  {
    sectionId: 'claude-memory',
    sectionGroup: 'Claude',
    sectionLabel: 'Memory & Context',
    settingId: 'file-read-max-output-tokens',
    label: 'File read max output tokens',
    description: 'Truncation limit for file-read tool output.',
    mapsTo: ['CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS'],
    keywords: ['file read', 'file tokens', 'read limit', 'file output']
  },
  {
    sectionId: 'claude-memory',
    sectionGroup: 'Claude',
    sectionLabel: 'Memory & Context',
    settingId: 'disable-claude-md-memory-files',
    label: 'Disable CLAUDE.md memory files',
    description: 'Prevent Claude from loading CLAUDE.md files from the filesystem.',
    mapsTo: ['CLAUDE_CODE_DISABLE_CLAUDE_MDS'],
    keywords: ['claude md', 'memory files', 'project memory', 'context files', 'disable memory']
  },
  {
    sectionId: 'claude-memory',
    sectionGroup: 'Claude',
    sectionLabel: 'Memory & Context',
    settingId: 'auto-compact-context-window',
    label: 'Auto-compact context window (tokens)',
    description: 'Token count at which Claude triggers context auto-compaction.',
    mapsTo: ['CLAUDE_CODE_AUTO_COMPACT_WINDOW'],
    keywords: ['auto compact', 'compact window', 'context window tokens', 'compaction trigger']
  },
  {
    sectionId: 'claude-memory',
    sectionGroup: 'Claude',
    sectionLabel: 'Memory & Context',
    settingId: 'auto-compact-percentage-override',
    label: 'Auto-compact percentage override (0–100)',
    description: 'Override the percentage of context used before auto-compaction triggers.',
    mapsTo: ['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'],
    keywords: ['compact percentage', 'compaction percent', 'auto compact override']
  },

  // ---------------------------------------------------------------------------
  // Claude › Tools
  // ---------------------------------------------------------------------------
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: '_section',
    label: 'MCP servers',
    description: 'MCP server toggles, auto-discovered from ~/.claude.json and each project\'s .mcp.json.',
    mapsTo: [],
    keywords: ['mcp', 'integration', 'external tools', 'model context protocol', 'server', 'plugin', 'tool server']
  },
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: 'bash-default-timeout',
    label: 'Bash default timeout (ms)',
    description: 'Default timeout in milliseconds for each Bash command.',
    mapsTo: ['BASH_DEFAULT_TIMEOUT_MS'],
    keywords: ['bash timeout', 'command timeout', 'shell timeout', 'timeout ms', 'bash limit']
  },
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: 'bash-max-timeout',
    label: 'Bash max timeout (ms)',
    description: 'Maximum timeout a user may request for a single Bash command.',
    mapsTo: ['BASH_MAX_TIMEOUT_MS'],
    keywords: ['bash max timeout', 'maximum timeout', 'shell max timeout']
  },
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: 'bash-max-output-length',
    label: 'Bash max output length',
    description: 'Maximum characters of stdout/stderr captured per command.',
    mapsTo: ['BASH_MAX_OUTPUT_LENGTH'],
    keywords: ['bash output', 'stdout limit', 'output truncation', 'command output length']
  },
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: 'tool-concurrency',
    label: 'Tool concurrency',
    description: 'How many tools Claude may run in parallel in a single turn.',
    mapsTo: ['CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY'],
    keywords: ['parallel tools', 'concurrent tools', 'tool parallelism', 'simultaneous tools']
  },
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: 'browser-integration',
    label: 'Browser integration',
    description: 'Enable claude\'s Chrome browser integration for web browsing and interaction.',
    mapsTo: [],
    keywords: ['browser', 'chrome', 'web browsing', 'web automation', 'browser tool']
  },
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: 'bash-maintains-project-cwd',
    label: 'Bash maintains project cwd',
    description: 'Each Bash command resets its working directory to the project root.',
    mapsTo: ['CLAUDE_CODE_BASH_MAINTAIN_PROJECT_WORKING_DIR'],
    keywords: ['working directory', 'cwd', 'bash cwd', 'project root', 'directory reset']
  },
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: 'perforce-mode',
    label: 'Perforce mode',
    description: 'Enable Perforce VCS integration for source control operations.',
    mapsTo: ['CLAUDE_CODE_PERFORCE_MODE'],
    keywords: ['perforce', 'p4', 'vcs', 'version control', 'source control']
  },
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: 'glob-includes-hidden-files',
    label: 'Glob includes hidden files (override)',
    description: 'When enabled, sets CLAUDE_CODE_GLOB_HIDDEN=1.',
    mapsTo: ['CLAUDE_CODE_GLOB_HIDDEN'],
    keywords: ['dotfiles', 'hidden files', 'glob hidden', 'show hidden', 'dot files']
  },
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: 'glob-ignores-gitignore',
    label: 'Glob ignores .gitignore (override)',
    description: 'When enabled, sets CLAUDE_CODE_GLOB_NO_IGNORE=1 so globs skip .gitignore patterns.',
    mapsTo: ['CLAUDE_CODE_GLOB_NO_IGNORE'],
    keywords: ['gitignore', 'glob ignore', 'ignore patterns', 'file exclusion']
  },
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: 'glob-timeout',
    label: 'Glob timeout (seconds)',
    description: 'Maximum seconds to spend on a single glob operation.',
    mapsTo: ['CLAUDE_CODE_GLOB_TIMEOUT_SECONDS'],
    keywords: ['glob timeout', 'file search timeout', 'glob time limit']
  },
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: 'disable-file-checkpointing',
    label: 'Disable file checkpointing',
    description: 'Prevent Claude from creating file snapshots before edits for potential rollback.',
    mapsTo: ['CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING'],
    keywords: ['checkpointing', 'file snapshot', 'rollback', 'undo', 'checkpoint']
  },
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: 'disable-attachments',
    label: 'Disable attachments',
    description: 'Prevent users from attaching files to Claude sessions.',
    mapsTo: ['CLAUDE_CODE_DISABLE_ATTACHMENTS'],
    keywords: ['attachments', 'file upload', 'attach file', 'disable upload']
  },
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: 'shell-override',
    label: 'Shell override',
    description: 'Use a specific shell binary instead of the default for Bash tool invocations.',
    mapsTo: ['CLAUDE_CODE_SHELL'],
    keywords: ['shell', 'bash', 'zsh', 'shell binary', 'shell path', 'custom shell']
  },
  {
    sectionId: 'claude-tools',
    sectionGroup: 'Claude',
    sectionLabel: 'Tools',
    settingId: 'shell-prefix',
    label: 'Shell prefix',
    description: 'Prepend a command prefix to every Bash invocation.',
    mapsTo: ['CLAUDE_CODE_SHELL_PREFIX'],
    keywords: ['shell prefix', 'nice', 'priority', 'command prefix', 'process priority']
  },

  // ---------------------------------------------------------------------------
  // Claude › Slash commands (section-level entry only)
  // ---------------------------------------------------------------------------
  {
    sectionId: 'claude-slash-commands',
    sectionGroup: 'Claude',
    sectionLabel: 'Slash commands',
    settingId: '_section',
    label: 'Slash commands',
    description: 'Custom commands from ~/.claude/commands/ and each project\'s .claude/commands/.',
    mapsTo: [],
    keywords: ['slash command', 'custom command', 'shortcuts', 'command alias', 'user commands', 'project commands']
  },

  // ---------------------------------------------------------------------------
  // Claude › Subagents (section-level entry only)
  // ---------------------------------------------------------------------------
  {
    sectionId: 'claude-subagents',
    sectionGroup: 'Claude',
    sectionLabel: 'Subagents',
    settingId: '_section',
    label: 'Subagents',
    description: 'Custom subagents from ~/.claude/agents/ and each project\'s .claude/agents/.',
    mapsTo: [],
    keywords: ['subagent', 'sub agent', 'agent', 'worker agent', 'parallel agent', 'specialized agent', 'claude agent']
  },

  // ---------------------------------------------------------------------------
  // Claude › Hooks (section-level entry only)
  // ---------------------------------------------------------------------------
  {
    sectionId: 'claude-hooks',
    sectionGroup: 'Claude',
    sectionLabel: 'Hooks',
    settingId: '_section',
    label: 'Hooks',
    description: 'Lifecycle event handlers — run shell scripts or commands at key points in every Claude Code session.',
    mapsTo: [],
    keywords: ['hooks', 'events', 'callbacks', 'scripts', 'pretooluse', 'posttooluse', 'lifecycle', 'session start', 'session end', 'automation', 'trigger']
  },

  // ---------------------------------------------------------------------------
  // Claude › Developer
  // ---------------------------------------------------------------------------
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'debug-logging',
    label: 'Debug logging',
    description: 'Pass --debug to Claude at launch for verbose output.',
    mapsTo: ['--debug'],
    keywords: ['debug', 'verbose', 'logging', 'log output', 'debug mode']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'log-level',
    label: 'Log level',
    description: 'Minimum severity level for log entries.',
    mapsTo: ['CLAUDE_CODE_DEBUG_LOG_LEVEL'],
    keywords: ['log level', 'severity', 'debug info warn error', 'logging level']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'disable-telemetry',
    label: 'Disable telemetry',
    description: 'Opt out of anonymous usage statistics sent to Anthropic.',
    mapsTo: ['DISABLE_TELEMETRY'],
    keywords: ['telemetry', 'analytics', 'tracking', 'privacy', 'usage stats', 'data collection', 'opt out']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'disable-error-reporting',
    label: 'Disable error reporting',
    description: 'Stop sending crash reports and stack traces to Anthropic.',
    mapsTo: ['DISABLE_ERROR_REPORTING'],
    keywords: ['crash reports', 'error reporting', 'stack traces', 'privacy', 'sentry', 'reporting']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'disable-auto-updater',
    label: 'Disable auto-updater',
    description: 'Prevent Orpheus from checking for or applying updates automatically.',
    mapsTo: ['DISABLE_AUTOUPDATER'],
    keywords: ['auto update', 'updater', 'disable updates', 'no updates', 'update check']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'agent-teams',
    label: 'Agent teams',
    description: 'Run multiple Claude instances collaborating on the same task in parallel.',
    mapsTo: ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'],
    keywords: ['experimental', 'agent teams', 'parallel instances', 'multi agent', 'collaboration']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'forked-subagents',
    label: 'Forked subagents',
    description: 'Allow Claude to spawn isolated subagent processes for long-running subtasks.',
    mapsTo: ['CLAUDE_CODE_FORK_SUBAGENT'],
    keywords: ['experimental', 'fork', 'subagent process', 'isolated agents', 'spawned agents']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'simple-system-prompt',
    label: 'Simple system prompt',
    description: 'Use a minimal system prompt without Orpheus-specific injections.',
    mapsTo: ['simpleSystemPrompt'],
    keywords: ['system prompt', 'minimal prompt', 'bare prompt', 'no injections']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'http-proxy',
    label: 'HTTP_PROXY',
    description: 'HTTP proxy for outbound requests from claude.',
    mapsTo: ['HTTP_PROXY'],
    keywords: ['proxy', 'network', 'corporate proxy', 'http proxy', 'outbound proxy', 'env var']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'https-proxy',
    label: 'HTTPS_PROXY',
    description: 'HTTPS proxy for outbound requests from claude.',
    mapsTo: ['HTTPS_PROXY'],
    keywords: ['proxy', 'network', 'corporate proxy', 'https proxy', 'ssl proxy', 'secure proxy', 'env var']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'api-timeout',
    label: 'API timeout (ms)',
    description: 'Timeout in milliseconds for each API request to Anthropic.',
    mapsTo: ['API_TIMEOUT_MS'],
    keywords: ['timeout', 'api timeout', 'request timeout', 'network timeout', 'connection timeout']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'max-retries',
    label: 'Max retries',
    description: 'Number of times to retry a failed API request.',
    mapsTo: ['CLAUDE_CODE_MAX_RETRIES'],
    keywords: ['retry', 'retries', 'retry limit', 'api retry', 'error retry']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'enable-fine-grained-tool-streaming',
    label: 'Enable fine-grained tool streaming',
    description: 'Stream tool results at a finer granularity for lower perceived latency.',
    mapsTo: ['CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING'],
    keywords: ['streaming', 'tool streaming', 'fine grained', 'latency', 'stream results']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'disable-nonstreaming-fallback',
    label: 'Disable nonstreaming fallback',
    description: 'Prevent Claude from falling back to non-streaming mode when streaming fails.',
    mapsTo: ['CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK'],
    keywords: ['streaming fallback', 'non streaming', 'fallback mode', 'stream failure']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'proxy-resolves-hosts',
    label: 'Proxy resolves hosts',
    description: 'Delegate hostname resolution to the proxy instead of resolving locally first.',
    mapsTo: ['CLAUDE_CODE_PROXY_RESOLVES_HOSTS'],
    keywords: ['dns', 'hostname', 'proxy dns', 'host resolution', 'name resolution']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'enable-gateway-model-discovery',
    label: 'Enable gateway model discovery',
    description: 'Allow Claude to discover available models through the gateway API.',
    mapsTo: ['CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'],
    keywords: ['gateway', 'model discovery', 'available models', 'dynamic models']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'disable-nonessential-traffic',
    label: 'Disable nonessential traffic',
    description: 'Bundles autoupdater, feedback, error reporting, and telemetry off in one toggle.',
    mapsTo: ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'],
    keywords: ['traffic', 'network traffic', 'background requests', 'all off', 'privacy bundle']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'honor-do-not-track',
    label: 'Honor DO_NOT_TRACK',
    description: 'Respect the DO_NOT_TRACK signal to disable analytics and usage tracking.',
    mapsTo: ['DO_NOT_TRACK'],
    keywords: ['do not track', 'dnt', 'privacy', 'tracking opt out', 'analytics opt out']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'disable-background-tasks',
    label: 'Disable background tasks',
    description: 'Prevent Claude from running background processing tasks between turns.',
    mapsTo: ['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'],
    keywords: ['background', 'background tasks', 'background processing', 'between turns']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'disable-agent-view',
    label: 'Disable agent view',
    description: 'Hide the real-time agent activity view during agentic sessions.',
    mapsTo: ['CLAUDE_CODE_DISABLE_AGENT_VIEW'],
    keywords: ['agent view', 'activity view', 'live view', 'agentic view', 'hide agent']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'auto-background-tasks',
    label: 'Auto background tasks',
    description: 'Allow Claude to automatically schedule background tasks without explicit user approval.',
    mapsTo: ['CLAUDE_CODE_AUTO_BACKGROUND_TASKS'],
    keywords: ['auto schedule', 'automatic tasks', 'background schedule']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'async-agent-stall-timeout',
    label: 'Async agent stall timeout (ms)',
    description: 'Milliseconds before an unresponsive async agent is considered stalled.',
    mapsTo: ['CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS'],
    keywords: ['stall timeout', 'agent stall', 'unresponsive', 'async timeout']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'enable-tasks',
    label: 'Enable tasks',
    description: 'Enable Claude\'s task management system for tracking long-running work items.',
    mapsTo: ['CLAUDE_CODE_ENABLE_TASKS'],
    keywords: ['tasks', 'task management', 'work items', 'long running tasks']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'disable-cron',
    label: 'Disable cron',
    description: 'Prevent Claude from creating or running scheduled (cron) tasks.',
    mapsTo: ['CLAUDE_CODE_DISABLE_CRON'],
    keywords: ['cron', 'scheduled tasks', 'cron jobs', 'disable scheduler']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'exit-after-stop-delay',
    label: 'Exit after stop delay (ms)',
    description: 'Milliseconds to wait after a stop signal before Claude exits.',
    mapsTo: ['CLAUDE_CODE_EXIT_AFTER_STOP_DELAY'],
    keywords: ['exit delay', 'stop delay', 'shutdown delay', 'graceful exit']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'disable-feedback-command',
    label: 'Disable feedback command',
    description: 'Remove the /feedback slash command from Claude\'s UI.',
    mapsTo: ['DISABLE_FEEDBACK_COMMAND'],
    keywords: ['feedback', 'feedback command', 'slash feedback', 'disable feedback']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'disable-feedback-survey',
    label: 'Disable feedback survey',
    description: 'Prevent the periodic in-session feedback survey prompt from appearing.',
    mapsTo: ['CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY'],
    keywords: ['survey', 'feedback survey', 'periodic prompt', 'disable survey', 'nps']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'anthropic-beta-headers',
    label: 'Anthropic-Beta headers',
    description: 'Comma-separated values for the anthropic-beta header on every request.',
    mapsTo: ['ANTHROPIC_BETAS'],
    keywords: ['beta', 'beta headers', 'anthropic betas', 'api headers', 'beta features']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'extra-body-json',
    label: 'Extra body JSON',
    description: 'Raw JSON object merged into every API request body.',
    mapsTo: ['CLAUDE_CODE_EXTRA_BODY'],
    keywords: ['extra body', 'request body', 'json body', 'api body', 'raw json']
  },
  {
    sectionId: 'claude-developer',
    sectionGroup: 'Claude',
    sectionLabel: 'Developer',
    settingId: 'custom-environment-variables',
    label: 'Custom environment variables',
    description: 'Raw key/value pairs merged into the claude launch env.',
    mapsTo: [],
    keywords: ['env vars', 'environment variables', 'custom env', 'launch env', 'env key', 'env value', 'key value', 'env override']
  },

  // ---------------------------------------------------------------------------
  // Claude › About Claude (section-level)
  // ---------------------------------------------------------------------------
  {
    sectionId: 'claude-about',
    sectionGroup: 'Claude',
    sectionLabel: 'About Claude',
    settingId: '_section',
    label: 'About Claude',
    description: 'Claude Code version, binary path, and links to documentation.',
    mapsTo: [],
    keywords: ['about', 'version', 'binary path', 'docs', 'documentation', 'changelog', 'claude version', 'which claude']
  },

  // ---------------------------------------------------------------------------
  // Orpheus › Appearance
  // ---------------------------------------------------------------------------
  {
    sectionId: 'orpheus-appearance',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Appearance',
    settingId: 'color-theme',
    label: 'Color theme',
    description: 'Dark is the only available theme for now. Light and System auto-switch are planned.',
    mapsTo: [],
    keywords: ['theme', 'dark', 'light', 'appearance', 'colors', 'color scheme', 'ui theme', 'dark mode', 'light mode']
  },
  {
    sectionId: 'orpheus-appearance',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Appearance',
    settingId: 'accent',
    label: 'Accent',
    description: 'Used for active states, highlights, and interactive elements throughout the UI.',
    mapsTo: [],
    keywords: ['accent color', 'highlight color', 'brand color', 'purple', 'blue', 'teal', 'pink', 'orange', 'color picker']
  },
  {
    sectionId: 'orpheus-appearance',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Appearance',
    settingId: 'ui-font-size-scale',
    label: 'UI font size scale',
    description: 'Scales all text in the Orpheus chrome (sidebar, settings, panels).',
    mapsTo: [],
    keywords: ['font size', 'text size', 'ui scale', 'typography', 'zoom', 'text scale']
  },

  // ---------------------------------------------------------------------------
  // Orpheus › Sidebar
  // ---------------------------------------------------------------------------
  {
    sectionId: 'orpheus-sidebar',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Sidebar',
    settingId: 'workspace-count-inline',
    label: 'Workspace count inline',
    description: 'Show · N next to project names showing workspace count.',
    mapsTo: [],
    keywords: ['workspace count', 'project count', 'sidebar count', 'badge', 'inline count']
  },
  {
    sectionId: 'orpheus-sidebar',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Sidebar',
    settingId: 'max-archived-workspaces',
    label: 'Max archived workspaces',
    description: 'Older archived workspaces are auto-deleted to stay under this cap.',
    mapsTo: [],
    keywords: ['archived workspaces', 'archive limit', 'workspace history', 'auto delete', 'cleanup']
  },
  {
    sectionId: 'orpheus-sidebar',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Sidebar',
    settingId: 'default-project-expanded',
    label: 'Default project expanded',
    description: 'New projects start with their workspaces visible in the sidebar.',
    mapsTo: [],
    keywords: ['expand', 'project expand', 'default expand', 'sidebar expand', 'project tree']
  },
  {
    sectionId: 'orpheus-sidebar',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Sidebar',
    settingId: 'sidebar-width',
    label: 'Sidebar width',
    description: 'Pixel width when the sidebar is expanded.',
    mapsTo: [],
    keywords: ['sidebar width', 'panel width', 'sidebar size', 'width px']
  },

  // ---------------------------------------------------------------------------
  // Orpheus › Window
  // ---------------------------------------------------------------------------
  {
    sectionId: 'orpheus-window',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Window',
    settingId: 'restore-window-geometry-on-launch',
    label: 'Restore window geometry on launch',
    description: 'Reopen at the same size and position as last quit.',
    mapsTo: [],
    keywords: ['window size', 'window position', 'restore window', 'geometry', 'window state', 'remember size']
  },
  {
    sectionId: 'orpheus-window',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Window',
    settingId: 'close-button-hides-orpheus',
    label: 'Close button hides Orpheus',
    description: 'On macOS, clicking the red close button hides the app instead of quitting.',
    mapsTo: [],
    keywords: ['close button', 'hide window', 'macos close', 'quit vs hide', 'red button', 'close behavior']
  },
  {
    sectionId: 'orpheus-window',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Window',
    settingId: 'open-at-last-view',
    label: 'Open at last view',
    description: 'Re-open the project, workspace, or dashboard you had active when Orpheus last closed.',
    mapsTo: [],
    keywords: ['restore view', 'last view', 'session restore', 'open state', 'last session']
  },
  {
    sectionId: 'orpheus-window',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Window',
    settingId: 'launch-at-login',
    label: 'Launch at login',
    description: 'Start Orpheus automatically when you log into macOS.',
    mapsTo: [],
    keywords: ['startup', 'boot', 'auto-start', 'login items', 'launch on startup', 'open on login', 'autostart']
  },
  {
    sectionId: 'orpheus-window',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Window',
    settingId: 'global-hotkey',
    label: 'Global hotkey',
    description: 'System-wide keyboard shortcut to bring Orpheus to the front from any app.',
    mapsTo: [],
    keywords: ['shortcut', 'keybinding', 'key combo', 'global key', 'hotkey', 'keyboard shortcut', 'bring to front', 'activate', 'global shortcut', 'system hotkey']
  },

  // ---------------------------------------------------------------------------
  // Orpheus › Updates
  // ---------------------------------------------------------------------------
  {
    sectionId: 'orpheus-updates',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Updates',
    settingId: 'auto-check-for-updates',
    label: 'Auto-check for updates',
    description: 'Periodically check for new Orpheus releases in the background.',
    mapsTo: [],
    keywords: ['update check', 'auto update', 'check updates', 'release check', 'background check']
  },
  {
    sectionId: 'orpheus-updates',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Updates',
    settingId: 'auto-install-updates',
    label: 'Auto-install updates',
    description: 'Download and apply updates automatically on next launch.',
    mapsTo: [],
    keywords: ['auto install', 'update install', 'automatic updates', 'silent updates']
  },
  {
    sectionId: 'orpheus-updates',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Updates',
    settingId: 'update-channel',
    label: 'Update channel',
    description: 'Stable receives tested releases. Beta gets early access to new features.',
    mapsTo: [],
    keywords: ['release channel', 'stable', 'beta channel', 'early access', 'update track']
  },
  {
    sectionId: 'orpheus-updates',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Updates',
    settingId: 'check-for-updates-now',
    label: 'Check for updates now',
    description: 'Manually trigger an update check against the release channel.',
    mapsTo: [],
    keywords: ['check now', 'manual update', 'force update check', 'update now']
  },

  // ---------------------------------------------------------------------------
  // Orpheus › Developer
  // ---------------------------------------------------------------------------
  {
    sectionId: 'orpheus-developer',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Developer',
    settingId: 'open-devtools',
    label: 'Open DevTools',
    description: 'Open Chromium DevTools in a detached window.',
    mapsTo: [],
    keywords: ['devtools', 'chromium devtools', 'inspector', 'debug renderer', 'console', 'developer tools']
  },
  {
    sectionId: 'orpheus-developer',
    sectionGroup: 'Orpheus',
    sectionLabel: 'Developer',
    settingId: 'reload-renderer',
    label: 'Reload renderer',
    description: 'Force a renderer reload without restarting Orpheus.',
    mapsTo: [],
    keywords: ['reload', 'renderer reload', 'hard reload', 'refresh renderer', 'dev reload']
  },

  // ---------------------------------------------------------------------------
  // Orpheus › About Orpheus (section-level)
  // ---------------------------------------------------------------------------
  {
    sectionId: 'orpheus-about',
    sectionGroup: 'Orpheus',
    sectionLabel: 'About Orpheus',
    settingId: '_section',
    label: 'About Orpheus',
    description: 'Version info, key file paths, and project links.',
    mapsTo: [],
    keywords: ['about', 'version', 'orpheus version', 'database path', 'log path', 'config dir', 'app info', 'github']
  }
]
