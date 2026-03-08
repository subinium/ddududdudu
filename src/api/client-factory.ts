import {
  AnthropicClient,
  type ApiMessage,
  type ToolStateUpdate,
  type UsageSummary,
} from './anthropic-client.js';
import { DEFAULT_ANTHROPIC_BASE_URL } from './anthropic-base-url.js';
import { ClaudeCliClient } from './claude-cli-client.js';
import { CodexClient } from './codex-client.js';
import { GeminiClient } from './gemini-client.js';
import { OpenAIClient } from './openai-client.js';

export interface StreamEvent {
  type: 'text' | 'done' | 'error' | 'tool_use' | 'tool_state' | 'session';
  text?: string;
  fullText?: string;
  usage?: {
    input: number;
    output: number;
    uncachedInput?: number;
    cachedInput?: number;
    cacheWriteInput?: number;
  };
  error?: Error;
  sessionId?: string;
  toolUseBlocks?: import('./anthropic-client.js').ToolUseContentBlock[];
  textSoFar?: string;
  toolStates?: ToolStateUpdate[];
}

export interface StreamOptions {
  systemPrompt: string;
  model: string;
  maxTokens?: number;
  signal?: AbortSignal;
  baseUrl?: string;
  tools?: import('./anthropic-client.js').ApiToolDefinition[];
  remoteSessionId?: string;
  cwd?: string;
}

export interface ApiClient {
  stream(messages: ApiMessage[], options: StreamOptions): AsyncGenerator<StreamEvent>;
}

const buildStreamAdapter = (
  runner: (
    options: StreamOptions,
    callbacks: {
      onText: (text: string) => void;
      onError: (error: Error) => void;
      onDone: (fullText: string, usage: { input: number; output: number }) => void;
      onToolUse?: (
        blocks: import('./anthropic-client.js').ToolUseContentBlock[],
        textSoFar: string,
        usage: UsageSummary,
      ) => void;
      onToolState?: (states: ToolStateUpdate[]) => void;
      onSession?: (sessionId: string) => void;
    },
  ) => Promise<void>,
  messages: ApiMessage[],
  options: StreamOptions,
): AsyncGenerator<StreamEvent> => {
  const queue: StreamEvent[] = [];
  let finished = false;
  let wake: (() => void) | null = null;

  const push = (event: StreamEvent): void => {
    queue.push(event);
    if (wake) {
      wake();
      wake = null;
    }
  };

  void runner(options, {
    onText: (text: string): void => {
      push({ type: 'text', text });
    },
    onError: (error: Error): void => {
      push({ type: 'error', error });
      finished = true;
      if (wake) {
        wake();
        wake = null;
      }
    },
    onDone: (fullText: string, usage: UsageSummary): void => {
      push({ type: 'done', fullText, usage });
      finished = true;
      if (wake) {
        wake();
        wake = null;
      }
    },
    onToolUse: (
      blocks: import('./anthropic-client.js').ToolUseContentBlock[],
      textSoFar: string,
      usage: UsageSummary,
    ): void => {
      push({ type: 'tool_use', toolUseBlocks: blocks, textSoFar, usage });
    },
    onToolState: (states: ToolStateUpdate[]): void => {
      push({ type: 'tool_state', toolStates: states });
    },
    onSession: (sessionId: string): void => {
      push({ type: 'session', sessionId });
    },
  }).catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error('Client streaming failed unexpectedly.');
    push({ type: 'error', error });
    finished = true;
    if (wake) {
      wake();
      wake = null;
    }
  });

  const iterate = async function* (): AsyncGenerator<StreamEvent> {
    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }

      while (queue.length > 0) {
        const event = queue.shift();
        if (!event) {
          continue;
        }

        yield event;
      }
    }
  };

  return iterate();
};

export const createClient = (provider: string, token: string, tokenType: string): ApiClient => {
  const normalized = provider.trim().toLowerCase();

  if (normalized === 'claude' || normalized === 'anthropic') {
    return {
      stream(messages: ApiMessage[], options: StreamOptions): AsyncGenerator<StreamEvent> {
        return buildStreamAdapter(
          async (streamOptions, callbacks) => {
            if (tokenType === 'oauth') {
              const client = new ClaudeCliClient({
                model: streamOptions.model,
                cwd: streamOptions.cwd,
              });

              await client.stream(
                streamOptions.systemPrompt,
                messages,
                {
                  onText: callbacks.onText,
                  onError: callbacks.onError,
                  onDone: callbacks.onDone,
                  onToolState: callbacks.onToolState,
                  onSession: callbacks.onSession,
                },
                streamOptions.signal,
                streamOptions.remoteSessionId,
              );
              return;
            }

            const client = new AnthropicClient({
              token,
              tokenType: 'apikey',
              baseUrl: streamOptions.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL,
              model: streamOptions.model,
              maxTokens: streamOptions.maxTokens,
            });

            await client.stream(
              streamOptions.systemPrompt,
              messages,
              {
                onText: callbacks.onText,
                onError: callbacks.onError,
                onDone: callbacks.onDone,
                onToolUse: callbacks.onToolUse,
              },
              streamOptions.signal,
              streamOptions.tools,
            );
          },
          messages,
          options,
        );
      },
    };
  }

  if (normalized === 'codex' || normalized === 'openai') {
    return {
      stream(messages: ApiMessage[], options: StreamOptions): AsyncGenerator<StreamEvent> {
        return buildStreamAdapter(
          async (streamOptions, callbacks) => {
            if (tokenType === 'bearer') {
              const client = new CodexClient({
                model: streamOptions.model,
                cwd: streamOptions.cwd,
              });

              await client.stream(
                streamOptions.systemPrompt,
                messages,
                {
                  onText: callbacks.onText,
                  onError: callbacks.onError,
                  onDone: callbacks.onDone,
                  onToolState: callbacks.onToolState,
                  onSession: callbacks.onSession,
                },
                streamOptions.signal,
                streamOptions.remoteSessionId,
              );
              return;
            }

            if (tokenType !== 'apikey') {
              const error = new Error(
                'OpenAI requests in ddudu require OPENAI_API_KEY or codex auth.'
              );
              callbacks.onError(error);
              throw error;
            }

            const client = new OpenAIClient({
              token,
              baseUrl: streamOptions.baseUrl ?? 'https://api.openai.com',
              model: streamOptions.model,
              maxTokens: streamOptions.maxTokens,
            });

            await client.stream(
              streamOptions.systemPrompt,
              messages,
              {
                onText: callbacks.onText,
                onError: callbacks.onError,
                onDone: callbacks.onDone,
              },
              streamOptions.signal,
            );
          },
          messages,
          options,
        );
      },
    };
  }

  if (normalized === 'gemini' || normalized === 'google') {
    return {
      stream(messages: ApiMessage[], options: StreamOptions): AsyncGenerator<StreamEvent> {
        return buildStreamAdapter(
          async (streamOptions, callbacks) => {
            const client = new GeminiClient({
              token,
              tokenType: tokenType === 'oauth' ? 'oauth' : 'apikey',
              baseUrl: streamOptions.baseUrl ?? 'https://generativelanguage.googleapis.com',
              model: streamOptions.model,
              maxTokens: streamOptions.maxTokens,
            });

            await client.stream(
              streamOptions.systemPrompt,
              messages,
              {
                onText: callbacks.onText,
                onError: callbacks.onError,
                onDone: callbacks.onDone,
              },
              streamOptions.signal,
            );
          },
          messages,
          options,
        );
      },
    };
  }

  throw new Error(`Unknown provider: ${provider}`);
};
