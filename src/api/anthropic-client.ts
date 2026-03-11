import { jsonSchema, streamText, tool } from 'ai';
import type { ModelMessage, Tool as AiTool } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { isOpenRouterAnthropicBaseUrl, normalizeAnthropicBaseUrl } from './anthropic-base-url.js';

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ToolUseContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContentBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextContentBlock | ToolUseContentBlock | ToolResultContentBlock;

export interface ToolStateUpdate {
  id: string;
  name: string;
  status: 'running' | 'done' | 'error';
  input?: Record<string, unknown>;
  result?: string;
}

export interface UsageSummary {
  input: number;
  output: number;
  uncachedInput?: number;
  cachedInput?: number;
  cacheWriteInput?: number;
}

export interface ApiMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ApiToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface StreamCallbacks {
  onText: (text: string) => void;
  onThinking?: (text: string) => void;
  onError: (error: Error) => void;
  onDone: (fullText: string, usage: UsageSummary) => void;
  onToolUse?: (
    blocks: ToolUseContentBlock[],
    textSoFar: string,
    usage: UsageSummary,
  ) => void;
  onToolState?: (states: ToolStateUpdate[]) => void;
  onSession?: (sessionId: string) => void;
}

export interface AnthropicClientConfig {
  token: string;
  tokenType?: 'apikey' | 'oauth';
  baseUrl: string;
  model: string;
  maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 4096;
const ANTHROPIC_1M_CONTEXT_BETA = 'context-1m-2025-08-07';

const toError = (error: unknown, fallbackMessage: string): Error => {
  if (error instanceof Error) {
    return error;
  }

  return new Error(fallbackMessage);
};

const toToolRecord = (tools: ApiToolDefinition[] | undefined): Record<string, AiTool> | undefined => {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const record: Record<string, AiTool> = {};
  for (const definition of tools) {
    record[definition.name] = tool<Record<string, unknown>>({
      description: definition.description,
      inputSchema: jsonSchema<Record<string, unknown>>(definition.input_schema),
    });
  }

  return record;
};

const supportsAnthropic1MContext = (model: string, baseUrl: string): boolean => {
  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel.startsWith('claude-sonnet-4')) {
    return false;
  }

  return baseUrl.includes('api.anthropic.com');
};

const buildMessages = (messages: ApiMessage[]): ModelMessage[] => {
  const toolNamesById = new Map<string, string>();
  const result: ModelMessage[] = [];

  for (const message of messages) {
    if (typeof message.content === 'string') {
      result.push({
        role: message.role,
        content: message.content,
      });
      continue;
    }

    if (message.role === 'assistant') {
      const content = message.content.map((block) => {
        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text };
        }

        if (block.type !== 'tool_use') {
          return { type: 'text' as const, text: '' };
        }

        toolNamesById.set(block.id, block.name);
        return {
          type: 'tool-call' as const,
          toolCallId: block.id,
          toolName: block.name,
          input: block.input,
        };
      });

      result.push({
        role: 'assistant',
        content,
      });
      continue;
    }

    const toolResults = message.content
      .filter((block): block is ToolResultContentBlock => block.type === 'tool_result')
      .map((block) => ({
      type: 'tool-result' as const,
      toolCallId: block.tool_use_id,
      toolName: toolNamesById.get(block.tool_use_id) ?? 'tool',
      output: block.is_error ? { type: 'error-text' as const, value: block.content } : { type: 'text' as const, value: block.content },
      }));

    result.push({
      role: 'tool',
      content: toolResults,
    });
  }

  return result;
};

export class AnthropicClient {
  private readonly config: AnthropicClientConfig;

  public constructor(config: AnthropicClientConfig) {
    this.config = {
      ...config,
      baseUrl: normalizeAnthropicBaseUrl(config.baseUrl),
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  }

  public async stream(
    systemPrompt: string,
    messages: ApiMessage[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    tools?: ApiToolDefinition[],
  ): Promise<void> {
    const model = this.config.model.trim();
    const provider = createAnthropic({
      baseURL: this.config.baseUrl,
      apiKey:
        !isOpenRouterAnthropicBaseUrl(this.config.baseUrl) && this.config.tokenType !== 'oauth'
          ? this.config.token
          : undefined,
      authToken:
        isOpenRouterAnthropicBaseUrl(this.config.baseUrl) || this.config.tokenType === 'oauth'
          ? this.config.token
          : undefined,
      headers: supportsAnthropic1MContext(model, this.config.baseUrl)
        ? { 'anthropic-beta': ANTHROPIC_1M_CONTEXT_BETA }
        : undefined,
    });

    const aiTools = toToolRecord(tools);

    try {
      const result = streamText({
        model: provider(model),
        system: systemPrompt.trim() || undefined,
        messages: buildMessages(messages),
        tools: aiTools,
        providerOptions: {
          anthropic: {
            sendReasoning: true,
            thinking: {
              type: 'enabled',
              budgetTokens: 10_000,
            },
          },
        },
        abortSignal: signal,
        maxOutputTokens: this.config.maxTokens,
      });

      let fullText = '';
      let finishReason = 'stop';
      let inputTokens = 0;
      let outputTokens = 0;
      const toolCalls: ToolUseContentBlock[] = [];

      for await (const chunk of result.fullStream) {
        if (chunk.type === 'text-delta') {
          const textDelta = (chunk as { text?: string; delta?: string }).text
            ?? (chunk as { text?: string; delta?: string }).delta
            ?? '';
          fullText += textDelta;
          callbacks.onText(textDelta);
          continue;
        }

        if (chunk.type === 'reasoning-delta') {
          const thinkingDelta = (chunk as { text?: string; delta?: string }).text
            ?? (chunk as { text?: string; delta?: string }).delta
            ?? '';
          if (thinkingDelta) {
            callbacks.onThinking?.(thinkingDelta);
          }
          continue;
        }

        if (chunk.type === 'tool-call') {
          toolCalls.push({
            type: 'tool_use',
            id: chunk.toolCallId,
            name: chunk.toolName,
            input: (chunk.input ?? {}) as Record<string, unknown>,
          });
          continue;
        }

        if (chunk.type === 'finish-step') {
          finishReason = chunk.finishReason;
          inputTokens = chunk.usage.inputTokens ?? inputTokens;
          outputTokens = chunk.usage.outputTokens ?? outputTokens;
          continue;
        }

        if (chunk.type === 'error') {
          throw chunk.error;
        }
      }

      const usage = await result.usage;
      inputTokens = usage.inputTokens ?? inputTokens;
      outputTokens = usage.outputTokens ?? outputTokens;

      if (finishReason === 'tool-calls' && toolCalls.length > 0 && callbacks.onToolUse) {
        callbacks.onToolUse(toolCalls, fullText, {
          input: inputTokens,
          output: outputTokens,
          uncachedInput: inputTokens,
          cachedInput: 0,
          cacheWriteInput: 0,
        });
        return;
      }

      callbacks.onDone(fullText, {
        input: inputTokens,
        output: outputTokens,
        uncachedInput: inputTokens,
        cachedInput: 0,
        cacheWriteInput: 0,
      });
    } catch (error: unknown) {
      const normalized = toError(error, 'Anthropic request failed unexpectedly.');
      callbacks.onError(normalized);
      throw normalized;
    }
  }
}
