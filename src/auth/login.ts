export type AuthProviderName = 'claude' | 'codex' | 'gemini';

export const AUTH_PROVIDERS: AuthProviderName[] = ['claude', 'codex', 'gemini'];

export const AUTH_SETUP_HINTS: Record<AuthProviderName, string> = {
  claude: "Run 'claude auth login' or set ANTHROPIC_API_KEY",
  codex: "Run 'codex login' or set OPENAI_API_KEY",
  gemini: 'Set GEMINI_API_KEY or configure ~/.gemini/oauth_creds.json',
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
