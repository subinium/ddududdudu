import { randomUUID } from 'node:crypto';
import { useCallback, useEffect, useRef } from 'react';
import type React from 'react';
import { DEFAULT_ANTHROPIC_BASE_URL } from '../../../api/anthropic-base-url.js';
import type { ApiMessage, ContentBlock, ToolUseContentBlock } from '../../../api/anthropic-client.js';
import { executeToolCalls, formatToolsForApi, type ToolResultBlock, type ToolUseBlock } from '../../../api/tool-executor.js';
import { TokenCounter } from '../../../core/token-counter.js';
import type { DduduConfig } from '../../../core/types.js';
import type { ToolContext } from '../../../tools/index.js';
import { BLACKPINK_MODES, BP_LYRICS } from '../theme.js';
import type { AppAction, AppState, ChatMessage, ToolCallInfo } from '../types.js';
import type { HarnessContext } from './useHarness.js';

type AskUserResolver = (answer: string) => void;

interface UseChatReturn {
  sendMessage: (content: string) => Promise<void>;
  abortCurrentRequest: () => void;
  resolveAskUser: (answer: string) => void;
  isProcessing: boolean;
}

const MAX_TOOL_TURNS_FALLBACK = 25;

const getRandomLyric = (): string => {
  const index = Math.floor(Math.random() * BP_LYRICS.length);
  return BP_LYRICS[index] ?? 'BLACKPINK in your area...';
};

const toApiMessages = (messages: ChatMessage[]): ApiMessage[] => {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
};

const toToolResultContent = (results: ToolResultBlock[]): ContentBlock[] => {
  return results.map((result) => ({
    type: 'tool_result',
    tool_use_id: result.tool_use_id,
    content: result.content,
    is_error: result.is_error,
  }));
};

const toAssistantToolUseContent = (
  text: string,
  blocks: ToolUseContentBlock[],
): ContentBlock[] => {
  const payload: ContentBlock[] = [];
  if (text.trim().length > 0) {
    payload.push({ type: 'text', text });
  }

  return payload.concat(blocks);
};

const getMaxTokens = (config: DduduConfig): number | undefined => {
  const maybeAgent = config.agent as unknown as Record<string, unknown>;
  const value = maybeAgent.max_tokens;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return undefined;
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return `[error] ${error.message}`;
  }

  return '[error] Request failed';
};

export const useChat = (
  dispatch: React.Dispatch<AppAction>,
  state: AppState,
  harness: HarnessContext,
  config: DduduConfig,
): UseChatReturn => {
  const stateRef = useRef(state);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const tokenCounterRef = useRef(new TokenCounter(config.agent.default_model));
  const askUserResolverRef = useRef<AskUserResolver | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const dispatchTokenUsage = useCallback((): void => {
    const usage = tokenCounterRef.current.getUsage();
    dispatch({
      type: 'SET_TOKENS',
      input: usage.inputTokens,
      output: usage.outputTokens,
      cost: usage.estimatedCost,
    });
    dispatch({
      type: 'SET_CONTEXT',
      percent: tokenCounterRef.current.getUsagePercent(),
    });
  }, [dispatch]);

  const abortCurrentRequest = useCallback((): void => {
    const controller = abortControllerRef.current;
    if (!controller) {
      return;
    }

    controller.abort();

    const streamingMessageId = activeAssistantMessageIdRef.current;
    if (streamingMessageId) {
      dispatch({
        type: 'FINISH_MESSAGE',
        id: streamingMessageId,
        content: '[request aborted]',
      });
    }

    dispatch({ type: 'SET_LOADING', loading: false });

    abortControllerRef.current = null;
    activeAssistantMessageIdRef.current = null;
  }, [dispatch]);

  const sendMessage = useCallback(async (content: string): Promise<void> => {
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      return;
    }

    if (stateRef.current.isLoading && abortControllerRef.current) {
      dispatch({ type: 'ENQUEUE_PROMPT', prompt: trimmedContent });
      return;
    }

    const modeConfig = BLACKPINK_MODES[stateRef.current.mode] ?? BLACKPINK_MODES.jennie;
    tokenCounterRef.current.setModel(modeConfig.model);

    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: trimmedContent,
      timestamp: Date.now(),
    };
    dispatch({ type: 'ADD_MESSAGE', message: userMessage });
    dispatch({ type: 'SET_LOADING', loading: true, lyric: getRandomLyric() });
    dispatch({ type: 'SET_INPUT', value: '' });

    const assistantMessageId = randomUUID();
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };
    dispatch({ type: 'ADD_MESSAGE', message: assistantMessage });

    if (!harness.activeClient) {
      dispatch({
        type: 'FINISH_MESSAGE',
        id: assistantMessageId,
        content: '[error] No active provider. Run: ddudu auth login',
      });
      dispatch({ type: 'SET_LOADING', loading: false });
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    activeAssistantMessageIdRef.current = assistantMessageId;

    const activeTab = stateRef.current.tabs[stateRef.current.activeTabIndex];
    const tabMessages = activeTab?.messages ?? [];
    const apiMessages = toApiMessages(tabMessages);
    // stateRef hasn't updated yet with the dispatched user message — append it manually
    apiMessages.push({ role: 'user', content: trimmedContent });
    const tools = harness.toolRegistry ? formatToolsForApi(harness.toolRegistry) : undefined;
    const maxTokens = getMaxTokens(config);

    let fullText = '';
    let done = false;
    let toolTurns = 0;
    let requestInputTokens = 0;
    let requestOutputTokens = 0;

    try {
      if (harness.hookRegistry) {
        await harness.hookRegistry.emit('beforeSend', {
          content: trimmedContent,
          mode: stateRef.current.mode,
          model: modeConfig.model,
        });
      }

      const MAX_TOOL_TURNS = config.agent?.max_turns ?? MAX_TOOL_TURNS_FALLBACK;

      while (!controller.signal.aborted && !done) {
        if (toolTurns >= MAX_TOOL_TURNS) {
          fullText = '[error] Maximum tool turns reached';
          dispatch({ type: 'FINISH_MESSAGE', id: assistantMessageId, content: fullText });
          break;
        }

        const stream = harness.activeClient.stream(apiMessages, {
          systemPrompt: harness.systemPrompt,
          model: modeConfig.model,
          tools,
          signal: controller.signal,
          maxTokens,
        });

        let continueWithTools = false;

        for await (const event of stream) {
          if (controller.signal.aborted) {
            break;
          }

          if (event.type === 'text') {
            const nextChunk = event.text ?? '';
            fullText += nextChunk;
            dispatch({ type: 'UPDATE_MESSAGE', id: assistantMessageId, content: fullText });
            continue;
          }

          if (event.type === 'tool_use') {
            const toolUseBlocks = event.toolUseBlocks ?? [];
            fullText = event.textSoFar ?? fullText;

            const toolCalls: ToolCallInfo[] = toolUseBlocks.map((block) => ({
              id: block.id,
              name: block.name,
              args: JSON.stringify(block.input),
              status: 'running' as const,
            }));

            const updateWithToolCalls = {
              type: 'UPDATE_MESSAGE' as const,
              id: assistantMessageId,
              content: fullText,
              toolCalls,
            };
            dispatch(updateWithToolCalls);

            for (const block of toolUseBlocks) {
              dispatch({
                type: 'SET_TOOL_STATUS',
                messageId: assistantMessageId,
                toolId: block.id,
                status: 'running',
              });
            }

            const usage = event.usage;
            if (usage) {
              requestInputTokens += usage.input;
              requestOutputTokens += usage.output;
            }

            const anthropicAuth = harness.availableProviders.get('anthropic');
            const toolContext: ToolContext = {
              cwd: process.cwd(),
              abortSignal: controller.signal,
              authToken: anthropicAuth?.token,
              authBaseUrl: process.env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL,
              askUser: (question: string, options?: string[]): Promise<string> => {
                return new Promise<string>((resolve) => {
                  askUserResolverRef.current = resolve;
                  dispatch({ type: 'ASK_USER', question, options });
                });
              },
            };

            const results = harness.toolRegistry
              ? await executeToolCalls(toolUseBlocks as ToolUseBlock[], harness.toolRegistry, toolContext)
              : toolUseBlocks.map((block): ToolResultBlock => ({
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: `Unknown tool registry; cannot execute ${block.name}`,
                  is_error: true,
                }));

            for (const result of results) {
              dispatch({
                type: 'SET_TOOL_STATUS',
                messageId: assistantMessageId,
                toolId: result.tool_use_id,
                status: result.is_error ? 'error' : 'done',
                result: result.content,
              });
            }

            apiMessages.push({
              role: 'assistant',
              content: toAssistantToolUseContent(fullText, toolUseBlocks),
            });
            apiMessages.push({
              role: 'user',
              content: toToolResultContent(results),
            });

            toolTurns += 1;
            continueWithTools = true;
            break;
          }

          if (event.type === 'done') {
            const usage = event.usage;
            if (usage) {
              requestInputTokens += usage.input;
              requestOutputTokens += usage.output;
            }

            fullText = event.fullText ?? fullText;
            dispatch({ type: 'FINISH_MESSAGE', id: assistantMessageId, content: fullText });
            done = true;
            break;
          }

          if (event.type === 'error') {
            fullText = toErrorMessage(event.error);
            dispatch({ type: 'FINISH_MESSAGE', id: assistantMessageId, content: fullText });
            done = true;
            break;
          }
        }

        if (controller.signal.aborted || done) {
          break;
        }

        if (!continueWithTools) {
          done = true;
        }
      }

      if (!controller.signal.aborted) {
        tokenCounterRef.current.addUsage(requestInputTokens, requestOutputTokens);
        dispatchTokenUsage();

        if (harness.hookRegistry) {
          await harness.hookRegistry.emit('afterResponse', {
            response: fullText,
            inputTokens: requestInputTokens,
            outputTokens: requestOutputTokens,
          });
        }

        if (harness.sessionManager && harness.sessionId) {
          await harness.sessionManager.append(harness.sessionId, {
            type: 'message',
            timestamp: new Date().toISOString(),
            data: {
              user: trimmedContent,
              assistant: fullText,
              mode: stateRef.current.mode,
              inputTokens: requestInputTokens,
              outputTokens: requestOutputTokens,
            },
          });
        }
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        const errorMessage = toErrorMessage(error);
        dispatch({ type: 'FINISH_MESSAGE', id: assistantMessageId, content: errorMessage });
      }
    } finally {
      if (controller.signal.aborted) {
        dispatch({
          type: 'FINISH_MESSAGE',
          id: assistantMessageId,
          content: '[request aborted]',
        });
      }

      dispatch({ type: 'SET_LOADING', loading: false });

      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      if (activeAssistantMessageIdRef.current === assistantMessageId) {
        activeAssistantMessageIdRef.current = null;
      }

      const [nextPrompt] = stateRef.current.queuedPrompts;
      if (nextPrompt) {
        dispatch({ type: 'DEQUEUE_PROMPT' });
        void sendMessage(nextPrompt);
      }
    }
  }, [config, dispatch, dispatchTokenUsage, harness]);

  useEffect(() => {
    if (!state.isLoading && state.queuedPrompts.length > 0 && !abortControllerRef.current) {
      const [nextPrompt] = state.queuedPrompts;
      if (nextPrompt) {
        dispatch({ type: 'DEQUEUE_PROMPT' });
        void sendMessage(nextPrompt);
      }
    }
  }, [dispatch, sendMessage, state.isLoading, state.queuedPrompts]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  const resolveAskUser = useCallback((answer: string): void => {
    const resolver = askUserResolverRef.current;
    if (resolver) {
      askUserResolverRef.current = null;
      dispatch({ type: 'ANSWER_USER' });
      resolver(answer);
    }
  }, [dispatch]);

  return {
    sendMessage,
    abortCurrentRequest,
    resolveAskUser,
    isProcessing: state.isLoading,
  };
};
