import type { NamedMode } from './types.js';

export type HarnessProviderName = 'anthropic' | 'openai' | 'gemini';

export interface ModeBindingCandidate {
  provider: HarnessProviderName;
  model: string;
}

export interface ResolvedModeBinding extends ModeBindingCandidate {
  mode: NamedMode;
  fallback: boolean;
}

const MODE_BINDING_CANDIDATES: Record<NamedMode, ModeBindingCandidate[]> = {
  jennie: [
    { provider: 'anthropic', model: 'claude-opus-4-6' },
    { provider: 'openai', model: 'gpt-5.4' },
    { provider: 'gemini', model: 'gemini-2.5-pro' },
  ],
  lisa: [
    { provider: 'openai', model: 'gpt-5.4' },
    { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    { provider: 'gemini', model: 'gemini-2.5-pro' },
  ],
  'rosé': [
    { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    { provider: 'openai', model: 'gpt-5.4' },
    { provider: 'gemini', model: 'gemini-2.5-pro' },
  ],
  jisoo: [
    { provider: 'gemini', model: 'gemini-2.5-pro' },
    { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    { provider: 'openai', model: 'gpt-5.4' },
  ],
};

export const getModeBindingCandidates = (mode: NamedMode): ModeBindingCandidate[] => {
  return MODE_BINDING_CANDIDATES[mode] ?? MODE_BINDING_CANDIDATES.jennie;
};

export const resolveModeBinding = (
  mode: NamedMode,
  hasProvider: (provider: HarnessProviderName) => boolean,
): ResolvedModeBinding => {
  const candidates = getModeBindingCandidates(mode);
  const match = candidates.find((candidate) => hasProvider(candidate.provider)) ?? candidates[0];
  const primary = candidates[0];

  return {
    mode,
    provider: match.provider,
    model: match.model,
    fallback: match.provider !== primary.provider || match.model !== primary.model,
  };
};
