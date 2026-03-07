export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL = 'https://openrouter.ai/api';

export const normalizeAnthropicBaseUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed === 'https://api.anthropic.com') {
    return DEFAULT_ANTHROPIC_BASE_URL;
  }

  return trimmed;
};

export const isOpenRouterAnthropicBaseUrl = (baseUrl: string): boolean => {
  return normalizeAnthropicBaseUrl(baseUrl).startsWith(DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL);
};
