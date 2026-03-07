import { spawn } from 'node:child_process';

import type {
  ApiMessage,
  StreamCallbacks,
  ToolStateUpdate,
} from './anthropic-client.js';

export interface ClaudeCliClientConfig {
  model: string;
  cwd?: string;
  command?: string;
}

interface ClaudeUsagePayload {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface ClaudeContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  text?: string;
}

interface ClaudeJsonEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  usage?: ClaudeUsagePayload;
  tool_use_result?: unknown;
  message?: {
    content?: ClaudeContentBlock[];
    usage?: ClaudeUsagePayload;
  };
  event?: {
    type?: string;
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
    };
  };
}

const DEFAULT_COMMAND = 'claude';

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

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

const buildPrompt = (messages: ApiMessage[]): string => {
  const lines: string[] = [
    'You are responding inside ddudu, a parent terminal harness.',
    'Continue the conversation below as the assistant.',
    "If you need tools, use Claude Code's native tools directly.",
    'Reply only with the next assistant message.',
    '<conversation>',
  ];

  for (const message of messages) {
    lines.push(`<message role="${message.role}">`);
    lines.push(normalizeContent(message.content));
    lines.push('</message>');
  }

  lines.push('</conversation>');
  return lines.join('\n');
};

const toError = (error: unknown, fallbackMessage: string): Error => {
  if (error instanceof Error) {
    return error;
  }

  return new Error(fallbackMessage);
};

const toTotalInputTokens = (usage: ClaudeUsagePayload | undefined): number => {
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0)
  );
};

const toOutputTokens = (usage: ClaudeUsagePayload | undefined): number => {
  return usage?.output_tokens ?? 0;
};

const extractToolResultText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractToolResultText(item))
      .filter((item) => item.trim().length > 0);
    return parts.join('\n');
  }

  if (!isRecord(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  if (typeof value.text === 'string' && value.text.trim()) {
    return value.text.trim();
  }

  if (typeof value.content === 'string' && value.content.trim()) {
    return value.content.trim();
  }

  if (Array.isArray(value.content)) {
    return extractToolResultText(value.content);
  }

  if (typeof value.filePath === 'string' && typeof value.numLines === 'number') {
    return `${value.filePath} · ${value.numLines} lines`;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const emitToolState = (
  callbacks: StreamCallbacks,
  emittedStates: Map<string, string>,
  state: ToolStateUpdate,
): void => {
  const signature = JSON.stringify({
    status: state.status,
    input: state.input ?? {},
    result: state.result ?? '',
  });
  if (emittedStates.get(state.id) === signature) {
    return;
  }

  emittedStates.set(state.id, signature);
  callbacks.onToolState?.([state]);
};

export class ClaudeCliClient {
  private readonly config: Required<ClaudeCliClientConfig>;

  public constructor(config: ClaudeCliClientConfig) {
    this.config = {
      model: config.model,
      cwd: config.cwd ?? process.cwd(),
      command: config.command?.trim() || process.env.DDUDU_CLAUDE_COMMAND?.trim() || DEFAULT_COMMAND,
    };
  }

  public async stream(
    systemPrompt: string,
    messages: ApiMessage[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<void> {
    const prompt = sessionId
      ? normalizeContent(messages[messages.length - 1]?.content ?? '')
      : buildPrompt(messages);
    const args = [
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--model',
      this.config.model,
      '--system-prompt',
      systemPrompt,
    ];
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    args.push(prompt);

    await new Promise<void>((resolve, reject) => {
      let fullText = '';
      let stderr = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finished = false;
      let stdoutBuffer = '';
      const toolNamesById = new Map<string, string>();
      const emittedStates = new Map<string, string>();

      const child = spawn(this.config.command, args, {
        cwd: this.config.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const finalizeDone = (): void => {
        if (finished) {
          return;
        }

        finished = true;
        callbacks.onDone(fullText, { input: inputTokens, output: outputTokens });
        resolve();
      };

      const finalizeError = (error: Error): void => {
        if (finished) {
          return;
        }

        finished = true;
        callbacks.onError(error);
        reject(error);
      };

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        let parsed: ClaudeJsonEvent;
        try {
          parsed = JSON.parse(trimmed) as ClaudeJsonEvent;
        } catch {
          return;
        }

        if (parsed.session_id) {
          callbacks.onSession?.(parsed.session_id);
        }

        if (parsed.type === 'stream_event' && parsed.event?.delta?.type === 'text_delta') {
          const text = parsed.event.delta.text ?? '';
          if (text) {
            fullText += text;
            callbacks.onText(text);
          }
          return;
        }

        if (parsed.type === 'assistant') {
          const blocks = parsed.message?.content ?? [];
          for (const block of blocks) {
            if (block.type !== 'tool_use' || !block.id || !block.name) {
              continue;
            }

            const input = isRecord(block.input) ? block.input : undefined;
            toolNamesById.set(block.id, block.name);
            emitToolState(callbacks, emittedStates, {
              id: block.id,
              name: block.name,
              input,
              status: 'running',
            });
          }
          return;
        }

        if (parsed.type === 'user') {
          const blocks = parsed.message?.content ?? [];
          for (const block of blocks) {
            if (block.type !== 'tool_result' || !block.tool_use_id) {
              continue;
            }

            emitToolState(callbacks, emittedStates, {
              id: block.tool_use_id,
              name: toolNamesById.get(block.tool_use_id) ?? 'tool',
              status: block.is_error || parsed.is_error ? 'error' : 'done',
              result: extractToolResultText(parsed.tool_use_result ?? block.content),
            });
          }
          return;
        }

        if (parsed.type === 'result') {
          const uncachedInput = parsed.usage?.input_tokens ?? 0;
          const cacheWriteInput = parsed.usage?.cache_creation_input_tokens ?? 0;
          const cachedInput = parsed.usage?.cache_read_input_tokens ?? 0;
          inputTokens = uncachedInput + cacheWriteInput + cachedInput;
          outputTokens = toOutputTokens(parsed.usage);

          if (parsed.is_error) {
            finalizeError(new Error(parsed.result?.trim() || stderr.trim() || 'Claude CLI request failed.'));
            return;
          }

          if (!fullText && parsed.result?.trim()) {
            fullText = parsed.result.trim();
          }
          if (finished) {
            return;
          }

          finished = true;
          callbacks.onDone(fullText, {
            input: inputTokens,
            output: outputTokens,
            uncachedInput,
            cachedInput,
            cacheWriteInput,
          });
          resolve();
        }
      };

      const flushStdoutBuffer = (): void => {
        let boundary = stdoutBuffer.indexOf('\n');
        while (boundary !== -1) {
          const line = stdoutBuffer.slice(0, boundary);
          stdoutBuffer = stdoutBuffer.slice(boundary + 1);
          processLine(line);
          boundary = stdoutBuffer.indexOf('\n');
        }
      };

      const abortHandler = (): void => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!finished) {
            child.kill('SIGKILL');
          }
        }, 250);
      };

      signal?.addEventListener('abort', abortHandler, { once: true });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        flushStdoutBuffer();
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('error', (error: Error) => {
        signal?.removeEventListener('abort', abortHandler);
        finalizeError(toError(error, 'Failed to start Claude CLI bridge.'));
      });

      child.on('close', (code) => {
        signal?.removeEventListener('abort', abortHandler);

        if (stdoutBuffer.trim()) {
          processLine(stdoutBuffer);
          stdoutBuffer = '';
        }

        if (finished) {
          return;
        }

        if (signal?.aborted) {
          finalizeError(new Error('Claude CLI request aborted.'));
          return;
        }

        if (code === 0) {
          finalizeDone();
          return;
        }

        const message = stderr.trim() || `Claude CLI exited with code ${code ?? 'unknown'}.`;
        finalizeError(new Error(message));
      });
    });
  }
}
