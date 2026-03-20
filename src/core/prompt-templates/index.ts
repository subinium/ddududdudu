import { ANTHROPIC_SYSTEM_APPENDIX } from './anthropic.js';
import { BASE_SYSTEM_PROMPT, DEFAULT_ORCHESTRATOR_PROMPT } from './base.js';
import { GEMINI_SYSTEM_APPENDIX } from './gemini.js';
import { OPENAI_SYSTEM_APPENDIX } from './openai.js';

const normalizeProvider = (provider: string): string => provider.trim().toLowerCase();

export const getDefaultSystemPrompt = (provider: string): string => {
  const normalized = normalizeProvider(provider);
  if (normalized === 'anthropic' || normalized === 'claude') {
    return `${BASE_SYSTEM_PROMPT}\n\n${ANTHROPIC_SYSTEM_APPENDIX}`;
  }
  if (normalized === 'openai' || normalized === 'codex') {
    return `${BASE_SYSTEM_PROMPT}\n\n${OPENAI_SYSTEM_APPENDIX}`;
  }
  if (normalized === 'gemini' || normalized === 'google') {
    return `${BASE_SYSTEM_PROMPT}\n\n${GEMINI_SYSTEM_APPENDIX}`;
  }
  return BASE_SYSTEM_PROMPT;
};

export { DEFAULT_ORCHESTRATOR_PROMPT, BASE_SYSTEM_PROMPT };
