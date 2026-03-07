export const BP = {
  pink: '#f7a7bb',
  pinkLight: '#fcd2de',
  pinkDim: '#be788c',
  black: '#000000',
  darkGray: '#121212',
  gray: '#646464',
  white: '#ffffff',
  red: '#ff5050',
  green: '#50dc78',
  yellow: '#ffc83c',
} as const;

export type BPColor = (typeof BP)[keyof typeof BP];

export interface BlackpinkMode {
  name: string;
  provider: 'anthropic' | 'openai' | 'gemini';
  model: string;
  label: string;
  tagline: string;
  description: string;
  promptAddition: string;
}

export const BLACKPINK_MODES: Record<string, BlackpinkMode> = {
  jennie: {
    name: 'jennie',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    label: 'JENNIE',
    tagline: 'Orchestration',
    description: 'Orchestration — balanced multi-agent coordination',
    promptAddition:
      'You are operating in JENNIE mode (orchestration).\n' +
      '- Classify each request as trivial, moderate, or complex before acting.\n' +
      '- Trivial: respond directly. Moderate: structured steps. Complex: spawn sub-agents.\n' +
      '- Use tools proactively: read files before edits, grep before assumptions.\n' +
      '- After changes, verify and report pass/fail outcomes.\n' +
      '- If ambiguous, use ask_question to clarify before risky changes.',
  },
  lisa: {
    name: 'lisa',
    provider: 'openai',
    model: 'gpt-5.4',
    label: 'LISA',
    tagline: 'Ultraworker',
    description: 'Ultraworker — fast execution, high throughput',
    promptAddition:
      'You are operating in LISA mode (ultraworker).\n' +
      '- Execute immediately, zero deliberation overhead.\n' +
      '- One-shot results, no back-and-forth unless hard-blocked.\n' +
      '- Never ask clarifying questions; make reasonable assumptions.\n' +
      '- Keep output minimal, action-oriented, free of prose.\n' +
      '- Run tool calls in parallel when independent.',
  },
  'rosé': {
    name: 'rosé',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    label: 'ROSÉ',
    tagline: 'Planning',
    description: 'Planning — deep thinking, architecture, strategy',
    promptAddition:
      'You are operating in ROSÉ mode (planning).\n' +
      '- Think step by step before acting; never jump to implementation.\n' +
      '- Build detailed plans with rationale for each decision.\n' +
      '- Enumerate edge cases, failure modes, recovery strategies.\n' +
      '- Use read_file and grep extensively for full context.\n' +
      '- Prefer correctness and maintainability over speed.',
  },
  jisoo: {
    name: 'jisoo',
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    label: 'JISOO',
    tagline: 'Design',
    description: 'Design — UI/UX focused, visual, creative',
    promptAddition:
      'You are operating in JISOO mode (design).\n' +
      '- Prioritize UI/UX quality, component architecture, visual direction.\n' +
      '- Design interactions across all states: hover, focus, loading, error, empty.\n' +
      '- Enforce accessibility: semantic structure, ARIA, keyboard nav, contrast.\n' +
      '- Apply systematic spacing, typography scales, disciplined color usage.\n' +
      '- Evaluate decisions from the user perspective.',
  },
};

export const MODE_ORDER = ['jennie', 'lisa', 'rosé', 'jisoo'] as const;

export const BP_LYRICS: string[] = [
  'Playing with fire...',
  'How you like that...',
  'Kill this love...',
  'Pretty savage...',
  'BLACKPINK in your area...',
  'Shut it down...',
  'Taste that pink venom...',
  'Hit you with that DDU-DU...',
  'Kick in the door...',
  'Light up the sky...',
  'We are the lovesick girls...',
  'Born to be alone...',
  "Make 'em whistle...",
  'We ride or die...',
  'So hot, I need a fan...',
  'Pedal to the metal...',
  'Think twice...',
  'Look at me, look at me now...',
  'Not a comeback, never left...',
  'Now burn, baby, burn...',
];

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
