export interface AutocompleteItem {
  label: string;
  description: string;
  value: string;
}

export const SLASH_COMMANDS: AutocompleteItem[] = [
  { label: '/clear', description: 'Clear current conversation', value: '/clear' },
  { label: '/compact', description: 'Compact context to save tokens', value: '/compact' },
  { label: '/mode', description: 'Switch harness mode', value: '/mode' },
  { label: '/model', description: 'Change model within current provider', value: '/model' },
  { label: '/plan', description: 'Show current execution plan', value: '/plan' },
  { label: '/todo', description: 'Manage plan items', value: '/todo' },
  { label: '/permissions', description: 'Set permission profile, tool policy, network, or secret trust', value: '/permissions' },
  { label: '/memory', description: 'Read, write, append, or clear scoped memory', value: '/memory' },
  { label: '/session', description: 'Inspect or resume saved sessions', value: '/session' },
  { label: '/config', description: 'Show current configuration', value: '/config' },
  { label: '/help', description: 'Show available commands', value: '/help' },
  { label: '/doctor', description: 'Check system health', value: '/doctor' },
  { label: '/context', description: 'Show active prompt context snapshot', value: '/context' },
  { label: '/review', description: 'Run code review checks', value: '/review' },
  { label: '/queue', description: 'Inspect or reorder queued prompts', value: '/queue' },
  { label: '/jobs', description: 'Inspect logs, results, and retries for detached jobs', value: '/jobs' },
  { label: '/artifacts', description: 'Show recent typed artifacts', value: '/artifacts' },
  { label: '/checkpoint', description: 'Create a git checkpoint', value: '/checkpoint' },
  { label: '/undo', description: 'Undo the last ddudu checkpoint', value: '/undo' },
  { label: '/handoff', description: 'Hand off context to a new session', value: '/handoff' },
  { label: '/fork', description: 'Fork the current session', value: '/fork' },
  { label: '/briefing', description: 'Generate a session briefing', value: '/briefing' },
  { label: '/drift', description: 'Check drift against the latest briefing', value: '/drift' },
  { label: '/quit', description: 'Exit ddudu', value: '/quit' },
  { label: '/exit', description: 'Exit ddudu', value: '/exit' },
  { label: '/fire', description: 'Toggle PLAYING_WITH_FIRE mode', value: '/fire' },
  { label: '/init', description: 'Initialize project config', value: '/init' },
  { label: '/skill', description: 'List loaded skills', value: '/skill' },
  { label: '/hook', description: 'Inspect or reload file-based hooks', value: '/hook' },
  { label: '/mcp', description: 'Inspect, add, trust, enable, disable, or reload MCP servers', value: '/mcp' },
  { label: '/team', description: 'Team agent management', value: '/team' },
];
