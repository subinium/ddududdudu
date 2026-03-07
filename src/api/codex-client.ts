import { spawn } from 'node:child_process';

import type {
  ApiMessage,
  StreamCallbacks,
  ToolStateUpdate,
} from './anthropic-client.js';

export interface CodexClientConfig {
  model: string;
  cwd?: string;
  command?: string;
}

interface CodexJsonItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  status?: string;
}

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  item?: CodexJsonItem;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
}

const DEFAULT_COMMAND = 'codex';

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

const buildPrompt = (systemPrompt: string, messages: ApiMessage[]): string => {
  const lines: string[] = [
    'You are responding inside ddudu, a parent terminal harness.',
    'Continue the conversation below as the assistant.',
    'Use Codex tools directly when needed.',
    'Reply only with the next assistant message.',
  ];

  if (systemPrompt.trim()) {
    lines.push('<system>');
    lines.push(systemPrompt.trim());
    lines.push('</system>');
  }

  lines.push(
    '<conversation>',
  );

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

export class CodexClient {
  private readonly config: Required<CodexClientConfig>;

  public constructor(config: CodexClientConfig) {
    this.config = {
      model: config.model,
      cwd: config.cwd ?? process.cwd(),
      command: config.command?.trim() || process.env.DDUDU_CODEX_COMMAND?.trim() || DEFAULT_COMMAND,
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
      : buildPrompt(systemPrompt, messages);
    const args = sessionId
      ? [
          'exec',
          'resume',
          '--json',
          '--skip-git-repo-check',
          '--dangerously-bypass-approvals-and-sandbox',
          '--model',
          this.config.model,
          sessionId,
          prompt,
        ]
      : [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--dangerously-bypass-approvals-and-sandbox',
          '--model',
          this.config.model,
          prompt,
        ];

    await new Promise<void>((resolve, reject) => {
      let fullText = '';
      let stderr = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finished = false;
      let stdoutBuffer = '';
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

        let parsed: CodexJsonEvent;
        try {
          parsed = JSON.parse(trimmed) as CodexJsonEvent;
        } catch {
          return;
        }

        if (parsed.type === 'thread.started' && parsed.thread_id) {
          callbacks.onSession?.(parsed.thread_id);
          return;
        }

        if (parsed.type === 'item.started' && parsed.item?.type === 'command_execution') {
          emitToolState(callbacks, emittedStates, {
            id: parsed.item.id ?? `cmd-${Date.now()}`,
            name: 'bash',
            status: 'running',
            input: { command: parsed.item.command ?? '' },
          });
          return;
        }

        if (parsed.type === 'item.completed' && parsed.item?.type === 'command_execution') {
          emitToolState(callbacks, emittedStates, {
            id: parsed.item.id ?? `cmd-${Date.now()}`,
            name: 'bash',
            status: parsed.item.status === 'completed' ? 'done' : 'error',
            input: { command: parsed.item.command ?? '' },
            result: parsed.item.aggregated_output ?? '',
          });
          return;
        }

        if (parsed.type === 'item.completed' && parsed.item?.type === 'agent_message') {
          const text = parsed.item.text ?? '';
          if (text) {
            fullText = text;
          }
          return;
        }

        if (parsed.type === 'turn.completed') {
          const uncachedInput = parsed.usage?.input_tokens ?? 0;
          const cachedInput = parsed.usage?.cached_input_tokens ?? 0;
          inputTokens = uncachedInput + cachedInput;
          outputTokens = parsed.usage?.output_tokens ?? 0;
          if (finished) {
            return;
          }

          finished = true;
          callbacks.onDone(fullText, {
            input: inputTokens,
            output: outputTokens,
            uncachedInput,
            cachedInput,
            cacheWriteInput: 0,
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
        finalizeError(toError(error, 'Failed to start Codex bridge.'));
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
          finalizeError(new Error('Codex request aborted.'));
          return;
        }

        if (code === 0) {
          finalizeDone();
          return;
        }

        const message = stderr.trim() || `codex exited with code ${code ?? 'unknown'}.`;
        finalizeError(new Error(message));
      });
    });
  }
}
