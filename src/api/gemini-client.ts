import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText } from 'ai';
import type { ApiMessage, StreamCallbacks } from './anthropic-client.js';

export interface GeminiClientConfig {
  token: string;
  baseUrl: string;
  model: string;
  tokenType: 'apikey' | 'oauth';
  maxTokens?: number;
}

interface GeminiCandidate {
  content?: {
    parts?: Array<{
      text?: string;
    }>;
  };
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}

interface GeminiSseEvent {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  error?: {
    message?: string;
  };
}

const DEFAULT_MAX_TOKENS = 4096;

const parseSseEvent = (rawEvent: string): { eventType: string; data: string } | null => {
  const lines = rawEvent
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return null;
  }

  let eventType = '';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    eventType: eventType || 'message',
    data: dataLines.join('\n'),
  };
};

const toError = (error: unknown, fallbackMessage: string): Error => {
  if (error instanceof Error) {
    return error;
  }

  return new Error(fallbackMessage);
};

const buildGeminiContents = (
  messages: ApiMessage[],
): Array<{
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}> => {
  return messages.map((message) => ({
    role: (message.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
    parts: [{ text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }],
  }));
};

const buildAiMessages = (
  messages: ApiMessage[],
): Array<{
  role: 'user' | 'assistant';
  content: string;
}> => {
  return messages.map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
  }));
};

export class GeminiClient {
  private readonly config: GeminiClientConfig;

  public constructor(config: GeminiClientConfig) {
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
    if (this.config.tokenType === 'apikey') {
      const provider = createGoogleGenerativeAI({
        apiKey: this.config.token,
        baseURL: this.config.baseUrl,
      });

      try {
        const result = streamText({
          model: provider(this.config.model.trim()),
          system: systemPrompt.trim() || undefined,
          messages: buildAiMessages(messages),
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
        return;
      } catch (error: unknown) {
        const normalized = toError(error, 'Gemini request failed unexpectedly.');
        callbacks.onError(normalized);
        throw normalized;
      }
    }

    const model = this.config.model.trim();
    const endpointBase = `${this.config.baseUrl}/v1beta/models/${model}:streamGenerateContent`;
    const endpoint = new URL(endpointBase);
    endpoint.searchParams.set('alt', 'sse');

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.config.token}`,
    };

    const body: Record<string, unknown> = {
      contents: buildGeminiContents(messages),
      generationConfig: {
        maxOutputTokens: this.config.maxTokens,
      },
    };

    if (systemPrompt.trim()) {
      body.systemInstruction = {
        parts: [{ text: systemPrompt }],
      };
    }

    const FETCH_TIMEOUT_MS = 60_000;
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(endpoint.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
    } catch (error: unknown) {
      const normalized = toError(error, 'Network error while calling Gemini API.');
      callbacks.onError(normalized);
      throw normalized;
    }

    if (!response.ok) {
      const rawError = await response.text();
      let message = `API request failed with status ${response.status}.`;

      try {
        const parsed = JSON.parse(rawError) as { error?: { message?: string } };
        const apiMessage = parsed.error?.message?.trim();
        if (apiMessage) {
          message = apiMessage;
        }
      } catch {
        const trimmed = rawError.trim();
        if (trimmed) {
          message = trimmed;
        }
      }

      const error = new Error(message);
      callbacks.onError(error);
      throw error;
    }

    if (!response.body) {
      const error = new Error('API response did not include a stream body.');
      callbacks.onError(error);
      throw error;
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let completed = false;

    const finalize = (): void => {
      if (completed) {
        return;
      }

      completed = true;
      callbacks.onDone(fullText, {
        input: inputTokens,
        output: outputTokens,
        uncachedInput: inputTokens,
        cachedInput: 0,
        cacheWriteInput: 0,
      });
    };

    const processEvent = (rawEvent: string): void => {
      const parsedEvent = parseSseEvent(rawEvent);
      if (!parsedEvent) {
        return;
      }

      if (parsedEvent.data === '[DONE]') {
        finalize();
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(parsedEvent.data);
      } catch {
        throw new Error('Failed to parse Gemini SSE payload.');
      }

      const event = payload as GeminiSseEvent;
      if (event.error?.message?.trim()) {
        throw new Error(event.error.message.trim());
      }

      const textParts = event.candidates?.[0]?.content?.parts ?? [];
      for (const part of textParts) {
        const text = part.text;
        if (typeof text === 'string' && text.length > 0) {
          fullText += text;
          callbacks.onText(text);
        }
      }

      const usage = event.usageMetadata;
      if (usage) {
        if (typeof usage.promptTokenCount === 'number' && Number.isFinite(usage.promptTokenCount)) {
          inputTokens = usage.promptTokenCount;
        }

        if (typeof usage.candidatesTokenCount === 'number' && Number.isFinite(usage.candidatesTokenCount)) {
          outputTokens = usage.candidatesTokenCount;
        }
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 5_000_000) {
          const error = new Error('Gemini SSE buffer overflow');
          callbacks.onError(error);
          throw error;
        }

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (rawEvent.trim()) {
            processEvent(rawEvent);
          }
          boundary = buffer.indexOf('\n\n');
        }
      }

      buffer += decoder.decode();
      const trailing = buffer.trim();
      if (trailing) {
        processEvent(trailing);
      }

      finalize();
    } catch (error: unknown) {
      const normalized = toError(error, 'Streaming API failed unexpectedly.');
      callbacks.onError(normalized);
      throw normalized;
    } finally {
      reader.releaseLock();
    }
  }
}
