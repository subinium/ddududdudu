import type {
  ApiMessage,
  ToolStateUpdate,
  UsageSummary,
} from './anthropic-client.js';
import { DEFAULT_ANTHROPIC_BASE_URL } from './anthropic-base-url.js';

export interface StreamEvent {
  type: 'text' | 'thinking' | 'done' | 'error' | 'tool_use' | 'tool_state' | 'session';
  text?: string;
  thinking?: string;
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

export interface ApiClientCapabilities {
  executionMode: 'api' | 'cli';
  supportsApiToolCalls: boolean;
  supportsToolState: boolean;
  supportsRemoteSession: boolean;
}

export interface ApiClient {
  readonly capabilities: ApiClientCapabilities;
  stream(messages: ApiMessage[], options: StreamOptions): AsyncGenerator<StreamEvent>;
}

const buildStreamAdapter = (
  runner: (
    options: StreamOptions,
    callbacks: {
      onText: (text: string) => void;
      onThinking?: (text: string) => void;
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
    onThinking: (thinking: string): void => {
      push({ type: 'thinking', thinking });
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

const createCapabilities = (
  executionMode: ApiClientCapabilities['executionMode'],
  options: {
    supportsApiToolCalls?: boolean;
    supportsToolState?: boolean;
    supportsRemoteSession?: boolean;
  } = {},
): ApiClientCapabilities => ({
  executionMode,
  supportsApiToolCalls: options.supportsApiToolCalls ?? false,
  supportsToolState: options.supportsToolState ?? false,
  supportsRemoteSession: options.supportsRemoteSession ?? false,
});

export const getClientCapabilities = (
  provider: string,
  tokenType: string,
): ApiClientCapabilities => {
  const normalized = provider.trim().toLowerCase();

  if (normalized === 'claude' || normalized === 'anthropic') {
    return tokenType === 'oauth'
      ? createCapabilities('cli', {
          supportsToolState: true,
          supportsRemoteSession: true,
        })
      : createCapabilities('api', {
          supportsApiToolCalls: true,
        });
  }

  if (normalized === 'codex' || normalized === 'openai') {
    return tokenType === 'bearer'
      ? createCapabilities('cli', {
          supportsToolState: true,
          supportsRemoteSession: true,
        })
      : createCapabilities('api');
  }

  if (normalized === 'gemini' || normalized === 'google') {
    return createCapabilities('api');
  }

  return createCapabilities('api');
};

export const createClient = (provider: string, token: string, tokenType: string): ApiClient => {
  const normalized = provider.trim().toLowerCase();
  const capabilities = getClientCapabilities(provider, tokenType);

  if (normalized === 'claude' || normalized === 'anthropic') {
    return {
      capabilities,
      stream(messages: ApiMessage[], options: StreamOptions): AsyncGenerator<StreamEvent> {
        return buildStreamAdapter(
          async (streamOptions, callbacks) => {
            if (tokenType === 'oauth') {
              const { ClaudeCliClient } = await import('./claude-cli-client.js');
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

            const { AnthropicClient } = await import('./anthropic-client.js');
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
                  onThinking: callbacks.onThinking,
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
      capabilities,
      stream(messages: ApiMessage[], options: StreamOptions): AsyncGenerator<StreamEvent> {
        return buildStreamAdapter(
          async (streamOptions, callbacks) => {
            if (tokenType === 'bearer') {
              const { CodexClient } = await import('./codex-client.js');
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

            const { OpenAIClient } = await import('./openai-client.js');
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
      capabilities,
      stream(messages: ApiMessage[], options: StreamOptions): AsyncGenerator<StreamEvent> {
        return buildStreamAdapter(
          async (streamOptions, callbacks) => {
            const { GeminiClient } = await import('./gemini-client.js');
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
