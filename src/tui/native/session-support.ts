import type { ApiMessage } from '../../api/anthropic-client.js';
import type { NativeMessageState, NativeRequestEstimateState } from './protocol.js';

export type CliBackedRequestMode = 'full' | 'resume' | 'hydrate';

export interface CliBackedSessionState {
  provider: string;
  sessionId: string;
  syncedMessageCount: number;
  lastModel: string;
  lastUsedAt: number;
}

export interface CompactionBuildOptions {
  assistantChars?: number;
  userChars?: number;
  systemChars?: number;
  toolResultChars?: number;
  maxToolCallsPerMessage?: number;
}

const normalizeContent = (content: ApiMessage['content']): string => {
  if (typeof content === 'string') {
    return content;
  }

  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
};

const clipText = (value: string, maxChars: number): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const keepHead = Math.max(Math.floor(maxChars * 0.72), 40);
  const keepTail = Math.max(maxChars - keepHead - 24, 24);
  return `${normalized.slice(0, keepHead)} … ${normalized.slice(-keepTail)}`;
};

const summarizeToolCall = (
  message: NativeMessageState,
  options: Required<CompactionBuildOptions>,
): string[] => {
  const toolCalls = (message.toolCalls ?? []).slice(0, options.maxToolCallsPerMessage);
  const lines = toolCalls.map((tool) => {
    const result = tool.result?.trim();
    return result
      ? `[tool:${tool.status}] ${clipText(tool.summary, 120)} => ${clipText(result, options.toolResultChars)}`
      : `[tool:${tool.status}] ${tool.summary}`;
  });

  const hiddenCount = (message.toolCalls ?? []).length - toolCalls.length;
  if (hiddenCount > 0) {
    lines.push(`[tool:summary] ${hiddenCount} additional tool updates omitted`);
  }

  return lines;
};

export const countApiMessageTokens = (
  messages: ApiMessage[],
  countTokens: (text: string) => number,
): number => {
  return messages.reduce((sum, message) => {
    return sum + countTokens(normalizeContent(message.content));
  }, 0);
};

export const buildCompactionMessages = (
  messages: NativeMessageState[],
  options: CompactionBuildOptions = {},
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> => {
  const normalizedOptions: Required<CompactionBuildOptions> = {
    assistantChars: options.assistantChars ?? 6000,
    userChars: options.userChars ?? 2400,
    systemChars: options.systemChars ?? 1200,
    toolResultChars: options.toolResultChars ?? 360,
    maxToolCallsPerMessage: options.maxToolCallsPerMessage ?? 4,
  };

  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'system')
    .map((message) => {
      const content =
        message.role === 'assistant'
          ? clipText(message.content.trim(), normalizedOptions.assistantChars)
          : message.role === 'system'
            ? clipText(message.content.trim(), normalizedOptions.systemChars)
            : clipText(message.content.trim(), normalizedOptions.userChars);
      const lines = [content, ...summarizeToolCall(message, normalizedOptions)].filter(
        (line) => line.trim().length > 0,
      );
      return {
        role: message.role as 'user' | 'assistant' | 'system',
        content: lines.join('\n'),
      };
    })
    .filter((message) => message.content.trim().length > 0);
};

export const createRequestEstimate = (input: {
  system: number;
  history: number;
  tools: number;
  prompt: number;
  mode: CliBackedRequestMode;
  note?: string;
}): NativeRequestEstimateState => {
  return {
    system: input.system,
    history: input.history,
    tools: input.tools,
    prompt: input.prompt,
    total: input.system + input.history + input.tools + input.prompt,
    mode: input.mode,
    note: input.note ?? null,
  };
};
