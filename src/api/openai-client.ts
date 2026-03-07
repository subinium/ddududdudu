import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { ApiMessage, StreamCallbacks } from './anthropic-client.js';

export interface OpenAIClientConfig {
  token: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 4096;

const toError = (error: unknown, fallbackMessage: string): Error => {
  if (error instanceof Error) {
    return error;
  }

  return new Error(fallbackMessage);
};

const buildMessages = (
  messages: ApiMessage[],
): Array<{
  role: 'user' | 'assistant';
  content: string;
}> => {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
  }));
};

export class OpenAIClient {
  private readonly config: OpenAIClientConfig;

  public constructor(config: OpenAIClientConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  }

  public async stream(
    systemPrompt: string,
    messages: ApiMessage[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const model = this.config.model.trim();
    if (!model) {
      const error = new Error('OpenAI model is empty.');
      callbacks.onError(error);
      throw error;
    }

    const provider = createOpenAI({
      apiKey: this.config.token,
      baseURL: this.config.baseUrl,
    });

    try {
      const result = streamText({
        model: provider(model),
        system: systemPrompt.trim() || undefined,
        messages: buildMessages(messages),
        abortSignal: signal,
        maxOutputTokens: this.config.maxTokens,
      });

      let fullText = '';
      for await (const chunk of result.textStream) {
        if (!chunk) {
          continue;
        }

        fullText += chunk;
        callbacks.onText(chunk);
      }

      const usage = await result.usage;
      callbacks.onDone(fullText, {
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        uncachedInput: usage.inputTokens ?? 0,
        cachedInput: 0,
        cacheWriteInput: 0,
      });
    } catch (error: unknown) {
      const normalized = toError(error, 'OpenAI request failed unexpectedly.');
      callbacks.onError(normalized);
      throw normalized;
    }
  }
}
