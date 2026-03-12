import { Codex, type ThreadEvent, type ThreadItem, type ThreadOptions } from '@openai/codex-sdk';

import type { ApiMessage, StreamCallbacks, ToolStateUpdate, UsageSummary } from './anthropic-client.js';

export interface CodexClientConfig {
  model: string;
  cwd?: string;
  command?: string;
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

  lines.push('<conversation>');

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

const createExecEnv = (): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
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

const summarizeFileChanges = (changes: Array<{ path: string; kind: string }> | undefined): string => {
  if (!changes || changes.length === 0) {
    return '';
  }

  const visible = changes.slice(0, 6).map((change) => `${change.kind}:${change.path}`);
  const hidden = changes.length - visible.length;
  return hidden > 0 ? `${visible.join(', ')} (+${hidden} more)` : visible.join(', ');
};

const toThreadOptions = (model: string, cwd: string): ThreadOptions => ({
  model,
  workingDirectory: cwd,
  skipGitRepoCheck: true,
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
  networkAccessEnabled: true,
});

export class CodexClient {
  private readonly model: string;
  private readonly cwd: string;
  private readonly commandOverride: string | null;

  public constructor(config: CodexClientConfig) {
    this.model = config.model;
    this.cwd = config.cwd ?? process.cwd();
    this.commandOverride = config.command?.trim() || process.env.DDUDU_CODEX_COMMAND?.trim() || null;
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

    const codex = new Codex({
      codexPathOverride:
        this.commandOverride && this.commandOverride !== DEFAULT_COMMAND ? this.commandOverride : undefined,
      env: createExecEnv(),
    });

    const threadOptions = toThreadOptions(this.model, this.cwd);
    const thread = sessionId ? codex.resumeThread(sessionId, threadOptions) : codex.startThread(threadOptions);

    const messageTexts = new Map<string, string>();
    const messageOrder: string[] = [];
    const emittedStates = new Map<string, string>();
    let aggregateText = '';
    let finalUsage: UsageSummary = {
      input: 0,
      output: 0,
      uncachedInput: 0,
      cachedInput: 0,
      cacheWriteInput: 0,
    };

    const updateAggregateText = (item: ThreadItem): void => {
      if (item.type !== 'agent_message') {
        return;
      }

      if (!messageTexts.has(item.id)) {
        messageOrder.push(item.id);
        if (messageOrder.length > 1000) {
          const removed = messageOrder.shift();
          if (removed) {
            messageTexts.delete(removed);
            emittedStates.delete(removed);
          }
        }
      }
      messageTexts.set(item.id, item.text);

      const nextText = messageOrder
        .map((id) => messageTexts.get(id) ?? '')
        .filter((text) => text.trim().length > 0)
        .join('\n\n');

      if (nextText.startsWith(aggregateText)) {
        const delta = nextText.slice(aggregateText.length);
        if (delta) {
          callbacks.onText(delta);
        }
      }

      aggregateText = nextText;
    };

    const handleItemEvent = (item: ThreadItem, eventType: ThreadEvent['type']): void => {
      updateAggregateText(item);

      if (item.type === 'command_execution') {
        emitToolState(callbacks, emittedStates, {
          id: item.id,
          name: 'bash',
          status: item.status === 'in_progress' ? 'running' : item.status === 'completed' ? 'done' : 'error',
          input: { command: item.command },
          result: item.aggregated_output || '',
        });
        return;
      }

      if (item.type === 'mcp_tool_call') {
        emitToolState(callbacks, emittedStates, {
          id: item.id,
          name: `${item.server}:${item.tool}`,
          status: item.status === 'in_progress' ? 'running' : item.status === 'completed' ? 'done' : 'error',
          input: { arguments: item.arguments ?? {} },
          result:
            item.error?.message ??
            item.result?.content?.map((block) => ('text' in block ? String(block.text ?? '') : '')).join('\n') ??
            '',
        });
        return;
      }

      if (item.type === 'web_search') {
        emitToolState(callbacks, emittedStates, {
          id: item.id,
          name: 'web_search',
          status: eventType === 'item.completed' ? 'done' : 'running',
          input: { query: item.query },
        });
        return;
      }

      if (item.type === 'file_change') {
        emitToolState(callbacks, emittedStates, {
          id: item.id,
          name: 'patch',
          status: item.status === 'completed' ? 'done' : 'error',
          result: summarizeFileChanges(item.changes),
        });
      }
    };

    try {
      const streamedTurn = await thread.runStreamed(prompt, { signal });

      for await (const event of streamedTurn.events) {
        if (event.type === 'thread.started') {
          callbacks.onSession?.(event.thread_id);
          continue;
        }

        if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
          handleItemEvent(event.item, event.type);
          continue;
        }

        if (event.type === 'turn.completed') {
          finalUsage = {
            input: (event.usage.input_tokens ?? 0) + (event.usage.cached_input_tokens ?? 0),
            output: event.usage.output_tokens ?? 0,
            uncachedInput: event.usage.input_tokens ?? 0,
            cachedInput: event.usage.cached_input_tokens ?? 0,
            cacheWriteInput: 0,
          };
          continue;
        }

        if (event.type === 'turn.failed') {
          throw new Error(event.error.message);
        }

        if (event.type === 'error') {
          throw new Error(event.message);
        }
      }

      callbacks.onDone(aggregateText, finalUsage);
    } catch (error: unknown) {
      const normalized = toError(error, 'Failed to stream Codex response.');
      callbacks.onError(normalized);
      throw normalized;
    }
  }
}
