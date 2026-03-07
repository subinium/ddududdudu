import { discoverToken } from '../api/oauth-discovery.js';
import { discoverClaudeToken } from './providers/claude.js';
import { discoverCodexToken } from './providers/codex.js';
import { discoverGeminiToken } from './providers/gemini.js';

export interface ProviderAuth {
  provider: string;
  token: string;
  source: string;
  tokenType: string;
}

export const discoverAllProviders = async (): Promise<Map<string, ProviderAuth>> => {
  const [claude, codex, gemini, legacyClaude] = await Promise.all([
    discoverClaudeToken(),
    discoverCodexToken(),
    discoverGeminiToken(),
    discoverToken().catch((err: unknown) => {
      void err;
      return null;
    }),
  ]);

  const discovered = new Map<string, ProviderAuth>();

  if (claude) {
    discovered.set('claude', {
      provider: 'claude',
      token: claude.token,
      source: claude.source,
      tokenType: claude.token.startsWith('sk-ant-oat01-') ? 'oauth' : 'apikey',
    });
  } else if (legacyClaude) {
    discovered.set('claude', {
      provider: 'claude',
      token: legacyClaude.token,
      source: `oauth-discovery:${legacyClaude.source}`,
      tokenType:
        legacyClaude.source === 'env-api-key' || legacyClaude.source === 'openrouter'
          ? 'apikey'
          : 'oauth',
    });
  }

  if (codex) {
    discovered.set('codex', {
      provider: 'codex',
      token: codex.token,
      source: codex.source,
      tokenType: codex.tokenType,
    });
  }

  if (gemini) {
    discovered.set('gemini', {
      provider: 'gemini',
      token: gemini.token,
      source: gemini.source,
      tokenType: gemini.tokenType,
    });
  }

  return discovered;
};

export const getPreferredProvider = async (): Promise<ProviderAuth | null> => {
  const discovered = await discoverAllProviders();
  const priority = ['claude', 'codex', 'gemini'];

  for (const provider of priority) {
    const auth = discovered.get(provider);
    if (auth) {
      return auth;
    }
  }

  const first = discovered.values().next();
  return first.done ? null : first.value;
};
