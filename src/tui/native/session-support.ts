import type { ApiMessage } from '../../api/anthropic-client.js';
import type { NativeMessageState, NativeRequestEstimateState } from './protocol.js';

export type BridgeRequestMode = 'full' | 'resume' | 'hydrate';

export interface BridgeSessionState {
  provider: string;
  sessionId: string;
  syncedMessageCount: number;
  lastModel: string;
  lastUsedAt: number;
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

const summarizeToolCall = (message: NativeMessageState): string[] => {
  return (message.toolCalls ?? []).map((tool) => {
    const result = tool.result?.trim();
    return result
      ? `[tool:${tool.status}] ${tool.summary} => ${result}`
      : `[tool:${tool.status}] ${tool.summary}`;
  });
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
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> => {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'system')
    .map((message) => {
      const lines = [message.content.trim(), ...summarizeToolCall(message)].filter(
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
  mode: BridgeRequestMode;
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
