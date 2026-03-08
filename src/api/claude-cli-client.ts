import {
  query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  ApiMessage,
  StreamCallbacks,
  ToolStateUpdate,
  UsageSummary,
} from './anthropic-client.js';

export interface ClaudeCliClientConfig {
  model: string;
  cwd?: string;
  command?: string;
}

type ClaudeContentBlock = {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  text?: string;
};

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

const toUsageSummary = (result: SDKResultMessage): UsageSummary => {
  const usage = result.usage;
  const uncachedInput = usage.input_tokens ?? 0;
  const cacheWriteInput = usage.cache_creation_input_tokens ?? 0;
  const cachedInput = usage.cache_read_input_tokens ?? 0;

  return {
    input: uncachedInput + cacheWriteInput + cachedInput,
    output: usage.output_tokens ?? 0,
    uncachedInput,
    cachedInput,
    cacheWriteInput,
  };
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

const extractAssistantText = (message: SDKAssistantMessage): string => {
  const content = Array.isArray(message.message?.content)
    ? (message.message.content as ClaudeContentBlock[])
    : [];

  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');
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

const createExecEnv = (): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
};

export class ClaudeCliClient {
  private readonly model: string;
  private readonly cwd: string;
  private readonly commandOverride: string | null;

  public constructor(config: ClaudeCliClientConfig) {
    this.model = config.model;
    this.cwd = config.cwd ?? process.cwd();
    this.commandOverride =
      config.command?.trim() || process.env.DDUDU_CLAUDE_COMMAND?.trim() || null;
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

    const agentQuery = query({
      prompt,
      options: {
        model: this.model,
        cwd: this.cwd,
        resume: sessionId,
        systemPrompt: systemPrompt.trim() || undefined,
        includePartialMessages: true,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        env: createExecEnv(),
        pathToClaudeCodeExecutable:
          this.commandOverride && this.commandOverride !== DEFAULT_COMMAND
            ? this.commandOverride
            : undefined,
      },
    });

    const toolNamesById = new Map<string, string>();
    const emittedStates = new Map<string, string>();
    let sessionEmitted = false;
    let fullText = '';
    let finalized = false;

    const abortHandler = (): void => {
      void agentQuery.interrupt().catch(() => {});
      agentQuery.close();
    };

    signal?.addEventListener('abort', abortHandler, { once: true });

    const maybeEmitSession = (message: { session_id: string }): void => {
      if (sessionEmitted) {
        return;
      }

      sessionEmitted = true;
      callbacks.onSession?.(message.session_id);
    };

    const handleAssistantMessage = (message: SDKAssistantMessage): void => {
      const blocks = Array.isArray(message.message?.content)
        ? (message.message.content as ClaudeContentBlock[])
        : [];

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

      if (!fullText) {
        const assistantText = extractAssistantText(message);
        if (assistantText) {
          fullText = assistantText;
        }
      }
    };

    const handleUserToolResult = (message: SDKUserMessage): void => {
      const blocks = Array.isArray(message.message?.content)
        ? (message.message.content as ClaudeContentBlock[])
        : [];

      for (const block of blocks) {
        if (block.type !== 'tool_result' || !block.tool_use_id) {
          continue;
        }

        emitToolState(callbacks, emittedStates, {
          id: block.tool_use_id,
          name: toolNamesById.get(block.tool_use_id) ?? 'tool',
          status: block.is_error ? 'error' : 'done',
          result: extractToolResultText(message.tool_use_result ?? block.content),
        });
      }
    };

    const handlePartialAssistant = (message: SDKPartialAssistantMessage): void => {
      const delta = message.event?.delta;
      if (delta?.type !== 'text_delta') {
        return;
      }

      const text = delta.text ?? '';
      if (!text) {
        return;
      }

      fullText += text;
      callbacks.onText(text);
    };

    try {
      for await (const message of agentQuery) {
        if ('session_id' in message && typeof message.session_id === 'string') {
          maybeEmitSession(message as { session_id: string });
        }

        if (message.type === 'stream_event') {
          handlePartialAssistant(message);
          continue;
        }

        if (message.type === 'assistant') {
          handleAssistantMessage(message);
          continue;
        }

        if (message.type === 'user') {
          handleUserToolResult(message);
          continue;
        }

        if (message.type === 'tool_progress') {
          emitToolState(callbacks, emittedStates, {
            id: message.tool_use_id,
            name: message.tool_name,
            status: 'running',
          });
          continue;
        }

        if (message.type === 'system' && message.subtype === 'task_started') {
          emitToolState(callbacks, emittedStates, {
            id: message.task_id,
            name: 'Task',
            status: 'running',
            input: { description: message.description, taskType: message.task_type ?? 'task' },
          });
          continue;
        }

        if (message.type === 'system' && message.subtype === 'task_progress') {
          emitToolState(callbacks, emittedStates, {
            id: message.task_id,
            name: 'Task',
            status: 'running',
            input: { description: message.description, lastTool: message.last_tool_name ?? '' },
          });
          continue;
        }

        if (message.type === 'system' && message.subtype === 'task_notification') {
          emitToolState(callbacks, emittedStates, {
            id: message.task_id,
            name: 'Task',
            status: message.status === 'completed' ? 'done' : 'error',
            result: message.summary,
          });
          continue;
        }

        if (message.type === 'result') {
          if (message.subtype !== 'success') {
            throw new Error(message.errors.join('\n') || 'Claude SDK request failed.');
          }

          if (!fullText && message.result.trim()) {
            fullText = message.result.trim();
          }

          callbacks.onDone(fullText, toUsageSummary(message));
          finalized = true;
        }
      }

      if (!finalized) {
        callbacks.onDone(fullText, {
          input: 0,
          output: 0,
          uncachedInput: 0,
          cachedInput: 0,
          cacheWriteInput: 0,
        });
      }
    } catch (error: unknown) {
      const normalized = signal?.aborted
        ? new Error('Claude request aborted.')
        : toError(error, 'Failed to stream Claude response.');
      callbacks.onError(normalized);
      throw normalized;
    } finally {
      signal?.removeEventListener('abort', abortHandler);
      agentQuery.close();
    }
  }
}
