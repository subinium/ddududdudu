import { PINK, PINK_LIGHT, DIM, RED, RESET } from './colors.js';

export interface CommandResult {
  lines: string[];
  action?: 'exit' | 'clear' | 'reset' | 'bash_toggle' | 'undo' | 'handoff' | 'review' | 'fork' | 'skill' | 'briefing' | 'mode_switch' | 'compact' | 'status' | 'queue_clear';
  actionData?: string;
}

interface CommandEntry {
  name: string;
  aliases: string[];
  args?: string;
  description: string;
  handler: (args: string) => CommandResult;
}

interface CommandRegistryConfig {
  provider: string;
  model: string;
  version: string;
  cwd: string;
  tabCount: number;
  activeTabName: string;
  queueLength: number;
}

const cmd = (
  name: string,
  aliases: string[],
  description: string,
  handler: (args: string) => CommandResult,
  args?: string,
): CommandEntry => ({ name, aliases, args, description, handler });

export const createCommands = (getConfig: () => CommandRegistryConfig): CommandEntry[] => [
  cmd('help', ['h', '?'], 'Show available commands', () => {
    const commands = createCommands(getConfig);
    const lines = [
      '',
      `  ${PINK}Available Commands${RESET}`,
      '',
    ];
    for (const c of commands) {
      const aliasText = c.aliases.length > 0 ? `${DIM}(${c.aliases.map(a => '/' + a).join(', ')})${RESET}` : '';
      const argText = c.args ? ` ${DIM}${c.args}${RESET}` : '';
      lines.push(`  ${PINK_LIGHT}/${c.name}${RESET}${argText}  ${c.description} ${aliasText}`);
    }
    lines.push('');
    return { lines };
  }),

  cmd('exit', ['quit', 'q'], 'Exit ddudu', () => ({
    lines: [`${DIM}Goodbye.${RESET}`],
    action: 'exit',
  })),

  cmd('clear', ['cls'], 'Clear chat history', () => ({
    lines: [],
    action: 'clear',
  })),

  cmd('reset', [], 'Reset conversation (clear + fresh start)', () => ({
    lines: [],
    action: 'reset',
  })),

  cmd('model', [], 'Show or switch model', (args) => {
    const cfg = getConfig();
    if (args.trim().length === 0) {
      return {
        lines: [
          '',
          `  ${PINK_LIGHT}model${RESET}     ${cfg.model}`,
          `  ${PINK_LIGHT}provider${RESET}  ${cfg.provider}`,
          '',
        ],
      };
    }
    return {
      lines: [`  ${DIM}Model switching will be available with direct API mode.${RESET}`],
    };
  }, '[name]'),

  cmd('provider', [], 'Show or switch provider', (args) => {
    const cfg = getConfig();
    if (args.trim().length === 0) {
      return {
        lines: [
          '',
          `  ${PINK_LIGHT}provider${RESET}  ${cfg.provider}`,
          `  ${PINK_LIGHT}command${RESET}   ${cfg.provider}`,
          '',
        ],
      };
    }
    return {
      lines: [`  ${DIM}Provider switching will be available with direct API mode.${RESET}`],
    };
  }, '[name]'),

  cmd('config', [], 'Show current configuration', () => {
    const cfg = getConfig();
    return {
      lines: [
        '',
        `  ${PINK}Configuration${RESET}`,
        `  ${PINK_LIGHT}provider${RESET}  ${cfg.provider}`,
        `  ${PINK_LIGHT}model${RESET}     ${cfg.model}`,
        `  ${PINK_LIGHT}cwd${RESET}       ${cfg.cwd}`,
        `  ${PINK_LIGHT}tabs${RESET}      ${cfg.tabCount}`,
        `  ${PINK_LIGHT}version${RESET}   ${cfg.version}`,
        '',
      ],
    };
  }),

  cmd('doctor', [], 'Run environment diagnostics', () => {
    const cfg = getConfig();
    return {
      lines: [
        '',
        `  ${PINK}Diagnostics${RESET}`,
        `  ${PINK_LIGHT}provider${RESET}   ${cfg.provider} ✓`,
        `  ${PINK_LIGHT}cwd${RESET}        ${cfg.cwd}`,
        `  ${PINK_LIGHT}node${RESET}       ${process.version}`,
        `  ${PINK_LIGHT}platform${RESET}   ${process.platform} ${process.arch}`,
        '',
      ],
    };
  }),

  cmd('version', ['v'], 'Show version', () => {
    const cfg = getConfig();
    return {
      lines: [`  ${PINK}♪ DDUDUDDUDU${RESET} ${DIM}${cfg.version}${RESET}`],
    };
  }),

  cmd('compact', [], 'Compact conversation context', () => ({
    lines: [`  ${DIM}Compacting conversation context...${RESET}`],
    action: 'compact',
  })),

  cmd('handoff', [], 'Hand off context to new thread', (args) => {
    if (args.trim().length === 0) {
      return {
        lines: [
          `  ${DIM}Usage: /handoff <goal>${RESET}`,
          `  ${DIM}Extracts context to a new tab for the given goal.${RESET}`,
        ],
      };
    }
    return {
      lines: [`  ${DIM}Preparing handoff for: ${args.trim()}${RESET}`],
      action: 'handoff',
      actionData: args.trim(),
    };
  }, '<goal>'),

  cmd('fork', [], 'Fork current session to new tab', () => ({
    lines: [`  ${DIM}Forking session to new tab...${RESET}`],
    action: 'fork',
  })),

  cmd('undo', [], 'Undo last file change (git revert)', () => ({
    lines: [`  ${DIM}Reverting last checkpoint...${RESET}`],
    action: 'undo',
  })),

  cmd('review', [], 'Run code review checks', () => ({
    lines: [`  ${DIM}Running code review checks...${RESET}`],
    action: 'review',
  })),

  cmd('mode', ['m'], 'Switch BLACKPINK mode', (args) => {
    const mode = args.trim().toLowerCase();
    const validModes = ['jennie', 'lisa', 'rosé', 'rose', 'jisoo', 'smart', 'rush', 'deep', 'design'];
    if (!mode || !validModes.includes(mode)) {
      return {
        lines: [
          '',
          `  ${PINK}BLACKPINK Modes${RESET}`,
          '',
          `  ${PINK_LIGHT}jennie${RESET}  sonnet  Orchestration — balanced coordination ${DIM}(alias: smart)${RESET}`,
          `  ${PINK_LIGHT}lisa${RESET}    haiku   Ultraworker — fast execution ${DIM}(alias: rush)${RESET}`,
          `  ${PINK_LIGHT}rosé${RESET}    opus    Planning — deep thinking ${DIM}(alias: deep)${RESET}`,
          `  ${PINK_LIGHT}jisoo${RESET}   sonnet  Design — UI/UX focused ${DIM}(alias: design)${RESET}`,
          '',
          `  ${DIM}Usage: /mode jennie|lisa|rosé|jisoo${RESET}`,
          '',
        ],
      };
    }
    return {
      lines: [],
      action: 'mode_switch',
      actionData: mode,
    };
  }, 'jennie|lisa|rosé|jisoo'),

  cmd('skill', [], 'List or invoke a skill', (args) => {
    if (args.trim().length === 0) {
      return {
        lines: [`  ${DIM}Scanning for skills...${RESET}`],
        action: 'skill',
      };
    }
    return {
      lines: [`  ${DIM}Loading skill: ${args.trim()}${RESET}`],
      action: 'skill',
      actionData: args.trim(),
    };
  }, '[name]'),

  cmd('bash', [], 'Toggle persistent bash mode', () => ({
    lines: [
      `  ${DIM}Bash mode toggled. Use !command for one-off, /bash for persistent.${RESET}`,
    ],
    action: 'bash_toggle',
  })),

  cmd('status', [], 'Show epistemic state and context info', () => ({
    lines: [`  ${DIM}Loading epistemic state...${RESET}`],
    action: 'status',
  })),

  cmd('queue', [], 'Show or clear queued messages', (args) => {
    const cfg = getConfig();
    const sub = args.trim().toLowerCase();
    if (sub === 'clear') {
      return {
        lines: [`  ${DIM}Clearing queue (${cfg.queueLength} pending)...${RESET}`],
        action: 'queue_clear',
      };
    }
    return {
      lines: [
        '',
        `  ${PINK_LIGHT}queue${RESET}  ${cfg.queueLength} pending`,
        `  ${DIM}Use /queue clear to empty queued messages.${RESET}`,
        '',
      ],
    };
  }, '[clear]'),

  cmd('briefing', [], 'Show or generate session briefing', () => ({
    lines: [`  ${DIM}Generating session briefing...${RESET}`],
    action: 'briefing',
  })),

  cmd('agents', [], 'Show sub-agent status', () => ({
    lines: [
      '',
      `  ${PINK}Sub-Agent Pool${RESET}`,
      `  ${PINK_LIGHT}status${RESET}    ready`,
      `  ${PINK_LIGHT}running${RESET}   0`,
      `  ${PINK_LIGHT}modes${RESET}     direct, parallel, sequential, oracle`,
      `  ${DIM}Prompts with numbered lists auto-parallelize.${RESET}`,
      `  ${DIM}Use "oracle" or "think harder" to route to stronger model.${RESET}`,
      '',
    ],
  })),

  cmd('oracle', [], 'Consult stronger model for current question', (args) => {
    if (args.trim().length === 0) {
      return {
        lines: [
          `  ${DIM}Usage: /oracle <question>${RESET}`,
          `  ${DIM}Routes to claude-opus-4-6 for deeper analysis.${RESET}`,
        ],
      };
    }
    return {
      lines: [`  ${DIM}Oracle mode active. Processing...${RESET}`],
    };
  }, '<question>'),

  cmd('tab', [], 'Tab management', (args) => {
    const sub = args.trim().split(/\s+/);
    const cfg = getConfig();

    if (sub[0] === 'list' || sub.length === 0 || sub[0] === '') {
      return {
        lines: [
          '',
          `  ${PINK_LIGHT}tabs${RESET}  ${cfg.tabCount} open, active: ${cfg.activeTabName}`,
          `  ${DIM}Ctrl+T new · Ctrl+W close · Ctrl+1-8 switch${RESET}`,
          '',
        ],
      };
    }

    if (sub[0] === 'new') {
      return {
        lines: [`  ${DIM}Use Ctrl+T to create a new tab.${RESET}`],
      };
    }

    if (sub[0] === 'close') {
      return {
        lines: [`  ${DIM}Use Ctrl+W to close the current tab.${RESET}`],
      };
    }

    return {
      lines: [`  ${RED}Unknown tab subcommand: ${sub[0]}${RESET}`],
    };
  }, 'list|new|close'),

  cmd('session', [], 'Session management', () => ({
    lines: [`  ${DIM}Session management will be available with direct API mode.${RESET}`],
  }), 'list|resume'),
];

export const executeCommand = (
  input: string,
  getConfig: () => CommandRegistryConfig,
): CommandResult | null => {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const withoutSlash = trimmed.slice(1);
  const spaceIdx = withoutSlash.indexOf(' ');
  const name = spaceIdx >= 0 ? withoutSlash.slice(0, spaceIdx) : withoutSlash;
  const args = spaceIdx >= 0 ? withoutSlash.slice(spaceIdx + 1) : '';

  const commands = createCommands(getConfig);
  const match = commands.find(
    (c) => c.name === name || c.aliases.includes(name),
  );

  if (!match) {
    return {
      lines: [
        `  ${RED}Unknown command: /${name}${RESET}`,
        `  ${DIM}Type /help for available commands.${RESET}`,
      ],
    };
  }

  return match.handler(args);
};
