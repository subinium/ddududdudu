export type AuthProviderName = 'claude' | 'codex' | 'gemini';
type HarnessModeName = 'jennie' | 'lisa' | 'rosé' | 'jisoo';

export const AUTH_PROVIDERS: AuthProviderName[] = ['claude', 'codex', 'gemini'];
const MODE_LABELS: Record<HarnessModeName, string> = {
  jennie: 'JENNIE',
  lisa: 'LISA',
  'rosé': 'ROSÉ',
  jisoo: 'JISOO',
};

export const AUTH_SETUP_HINTS: Record<AuthProviderName, string> = {
  claude: 'Claude Code login or ANTHROPIC_API_KEY',
  codex: 'Codex login or OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY or ~/.gemini/oauth_creds.json',
};

export const AUTH_PROVIDER_DESCRIPTIONS: Record<AuthProviderName, string> = {
  claude: 'orchestration',
  codex: 'execution',
  gemini: 'design',
};

export const normalizeAuthProviderName = (value: string | null | undefined): AuthProviderName | null => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === 'openai') {
    return 'codex';
  }

  if (AUTH_PROVIDERS.includes(normalized as AuthProviderName)) {
    return normalized as AuthProviderName;
  }

  return null;
};

export const resolveRequestedAuthProvider = (
  args: string[],
  flags: Record<string, string | boolean>,
): AuthProviderName | 'all' | null => {
  const rawValue =
    typeof flags.provider === 'string'
      ? flags.provider
      : typeof flags.p === 'string'
        ? flags.p
        : args[0];

  if (!rawValue) {
    return null;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'all') {
    return 'all';
  }

  return normalizeAuthProviderName(normalized);
};

export const buildGeminiLoginHelp = (): string[] => {
  return [
    'Gemini auth in ddudu currently uses existing local credentials rather than a guided browser flow.',
    '',
    'Supported paths:',
    '  1. Set GEMINI_API_KEY',
    '  2. Reuse ~/.gemini/oauth_creds.json',
    '',
    'Then run: ddudu auth',
  ];
};

const MODE_BINDINGS: Record<HarnessModeName, { provider: AuthProviderName; model: string }[]> = {
  jennie: [
    { provider: 'claude', model: 'claude-opus-4-6' },
    { provider: 'codex', model: 'gpt-5.4' },
    { provider: 'gemini', model: 'gemini-2.5-pro' },
  ],
  lisa: [
    { provider: 'codex', model: 'gpt-5.4' },
    { provider: 'claude', model: 'claude-sonnet-4-6' },
    { provider: 'gemini', model: 'gemini-2.5-pro' },
  ],
  'rosé': [
    { provider: 'claude', model: 'claude-sonnet-4-6' },
    { provider: 'codex', model: 'gpt-5.4' },
    { provider: 'gemini', model: 'gemini-2.5-pro' },
  ],
  jisoo: [
    { provider: 'gemini', model: 'gemini-2.5-pro' },
    { provider: 'claude', model: 'claude-sonnet-4-6' },
    { provider: 'codex', model: 'gpt-5.4' },
  ],
};

export const buildResolvedModeSummary = (
  hasProvider: (provider: AuthProviderName) => boolean,
): string[] => {
  const modes: HarnessModeName[] = ['jennie', 'lisa', 'rosé', 'jisoo'];
  return modes.map((mode) => {
    const resolved = MODE_BINDINGS[mode].find((binding) => hasProvider(binding.provider)) ?? MODE_BINDINGS[mode][0];
    return `  ${MODE_LABELS[mode]} -> ${resolved.model} (${resolved.provider})`;
  });
};

export const buildAuthModeHighlights = (
  hasProvider: (provider: AuthProviderName) => boolean,
): string[] => {
  const lines: string[] = [];

  if (hasProvider('claude')) {
    lines.push('  Claude unlocks JENNIE (Opus 4.6) and ROSÉ (Sonnet 4.6).');
  }
  if (hasProvider('codex')) {
    lines.push('  Codex unlocks LISA and acts as fallback for all modes with GPT-5.4.');
  }
  if (hasProvider('gemini')) {
    lines.push('  Gemini unlocks JISOO for design and multimodal work.');
  }

  return lines;
};
