import type { ToolResultBlock } from '../../api/tool-executor.js';
import type { LoopWarning } from '../../core/loop-detector.js';
import type { NativeMessageState, NativeToolCallState } from './protocol.js';

export const updateMessageInState = (
  messages: NativeMessageState[],
  id: string,
  content: string,
  toolCalls?: NativeToolCallState[],
): NativeMessageState[] => {
  return messages.map((message) => {
    if (message.id !== id) {
      return message;
    }

    return {
      ...message,
      content,
      toolCalls: toolCalls ?? message.toolCalls,
    };
  });
};

export const finishMessageInState = (
  messages: NativeMessageState[],
  id: string,
  content: string,
): NativeMessageState[] => {
  return messages.map((message) => {
    if (message.id !== id) {
      return message;
    }

    return {
      ...message,
      content,
      isStreaming: false,
    };
  });
};

export const setToolStatusInState = (
  messages: NativeMessageState[],
  messageId: string,
  toolId: string,
  status: NativeToolCallState['status'],
  result?: string,
): NativeMessageState[] => {
  return messages.map((message) => {
    if (message.id !== messageId || !message.toolCalls) {
      return message;
    }

    return {
      ...message,
      toolCalls: message.toolCalls.map((toolCall) => {
        if (toolCall.id !== toolId) {
          return toolCall;
        }

        return {
          ...toolCall,
          status,
          result: result ?? toolCall.result,
        };
      }),
    };
  });
};

export const applyToolStatesToMessages = (
  messages: NativeMessageState[],
  messageId: string,
  states: Array<{
    id: string;
    name: string;
    status: 'running' | 'done' | 'error';
    input?: Record<string, unknown>;
    result?: string;
  }>,
  summarizeToolInput: (name: string, input?: Record<string, unknown>) => string,
  summarizeToolResult: (result: string) => string,
): NativeMessageState[] => {
  if (states.length === 0) {
    return messages;
  }

  return messages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }

    const existing = new Map((message.toolCalls ?? []).map((tool) => [tool.id, tool]));
    for (const state of states) {
      const current = existing.get(state.id);
      existing.set(state.id, {
        id: state.id,
        name: state.name,
        args: state.input ? JSON.stringify(state.input) : (current?.args ?? '{}'),
        summary: current?.summary ?? summarizeToolInput(state.name, state.input ?? {}),
        status: state.status,
        result: state.result ? summarizeToolResult(state.result) : current?.result,
      });
    }

    return {
      ...message,
      toolCalls: Array.from(existing.values()),
    };
  });
};

export const appendLoopWarnings = (
  apiMessages: Array<{ role: 'user' | 'assistant'; content: unknown }>,
  warnings: LoopWarning[],
): string | null => {
  if (warnings.length === 0) {
    return null;
  }
  const warningText = warnings.map((warning) => warning.message).join('\n');
  apiMessages.push({
    role: 'user',
    content: `[loop warning]\n${warningText}`,
  });
  return warningText;
};

export const mapToolResultErrors = (
  blocks: Array<{ name: string; input: Record<string, unknown> }>,
  results: ToolResultBlock[],
): Array<{ name: string; input: Record<string, unknown>; output: unknown; error: string | null }> => {
  return blocks.map((block, index) => ({
    name: block.name,
    input: block.input,
    output: results[index]?.content ?? null,
    error: results[index]?.is_error ? String(results[index]?.content ?? '') : null,
  }));
};
