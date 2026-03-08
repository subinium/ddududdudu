export interface ContextProfileInput {
  provider: string;
  model: string;
  providerWindowTokens: number;
  cliBacked: boolean;
  triggerRatio: number;
}

export interface ContextProfile {
  providerWindowTokens: number;
  canonicalWorkingSetTokens: number;
  autoCompactAtTokens: number;
  hydrateInlineMessages: number;
  maxToolCallsPerMessage: number;
  toolResultChars: number;
  assistantChars: number;
  userChars: number;
  systemChars: number;
}

export const deriveContextProfile = (input: ContextProfileInput): ContextProfile => {
  const triggerRatio = Math.min(Math.max(input.triggerRatio, 0.4), 0.95);
  let providerWindowTokens = Math.max(input.providerWindowTokens, 32_000);

  if (
    input.cliBacked &&
    input.provider === 'anthropic' &&
    input.model.startsWith('claude-sonnet-4')
  ) {
    providerWindowTokens = Math.min(providerWindowTokens, 200_000);
  }

  let canonicalWorkingSetTokens = input.cliBacked
    ? Math.min(Math.floor(providerWindowTokens * 0.35), 180_000)
    : Math.min(Math.floor(providerWindowTokens * 0.6), 260_000);

  if (input.provider === 'openai' && input.model.startsWith('gpt-5.4')) {
    canonicalWorkingSetTokens = input.cliBacked
      ? Math.min(canonicalWorkingSetTokens, 180_000)
      : Math.min(Math.floor(providerWindowTokens * 0.5), 260_000);
  }

  if (input.provider === 'anthropic' && input.model.startsWith('claude-sonnet-4')) {
    canonicalWorkingSetTokens = input.cliBacked
      ? Math.min(canonicalWorkingSetTokens, 220_000)
      : Math.min(Math.floor(providerWindowTokens * 0.55), 320_000);
  }

  canonicalWorkingSetTokens = Math.max(canonicalWorkingSetTokens, 48_000);

  return {
    providerWindowTokens,
    canonicalWorkingSetTokens,
    autoCompactAtTokens: Math.floor(canonicalWorkingSetTokens * triggerRatio),
    hydrateInlineMessages: input.cliBacked ? 3 : 5,
    maxToolCallsPerMessage: input.cliBacked ? 2 : 4,
    toolResultChars: input.cliBacked ? 220 : 360,
    assistantChars: input.cliBacked ? 3_600 : 6_000,
    userChars: 2_400,
    systemChars: 1_200,
  };
};
