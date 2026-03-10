import type { ApiMessage } from '../../api/anthropic-client.js';
import type { ApiClient, ApiClientCapabilities, StreamEvent } from '../../api/client-factory.js';
import type { CliBackedRequestMode } from './session-support.js';

export interface RequestExecutionPlan {
  apiMessages: ApiMessage[];
  mode: CliBackedRequestMode;
  note: string | null;
  remoteSessionId: string | null;
}

export interface RequestStreamOutcome {
  fullText: string;
  inputTokens: number;
  outputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  done: boolean;
  continueWithTools: boolean;
}

export interface RequestEngineInput {
  client: ApiClient;
  capabilities: ApiClientCapabilities;
  provider: string;
  model: string;
  sessionId?: string | null;
  cwd: string;
  plan: RequestExecutionPlan;
  systemPrompt: string;
  tools?: unknown;
  maxTokens?: number;
  maxToolTurns: number;
  signal: AbortSignal;
}

export interface RequestEngineCallbacks {
  beforeApiCall?: (input: {
    provider: string;
    model: string;
    sessionId?: string | null;
    remoteSessionId: string | null;
    requestMode: CliBackedRequestMode;
    toolTurn: number;
    cwd: string;
  }) => Promise<void> | void;
  afterApiCall?: (input: {
    provider: string;
    model: string;
    sessionId?: string | null;
    remoteSessionId: string | null;
    requestMode: CliBackedRequestMode;
    toolTurn: number;
    continuedWithTools?: boolean;
    done?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
    cwd: string;
    error?: string;
  }) => Promise<void> | void;
  consumeStream: (input: {
    stream: AsyncGenerator<StreamEvent>;
    apiMessages: ApiMessage[];
    currentText: string;
    requestInputTokens: number;
    requestOutputTokens: number;
    requestUncachedInputTokens: number;
    requestCachedInputTokens: number;
    requestCacheWriteInputTokens: number;
    signal: AbortSignal;
    onSession?: (sessionId: string) => void;
  }) => Promise<RequestStreamOutcome>;
  onSessionObserved?: (input: { sessionId: string; phase: 'stream' | 'final'; plan: RequestExecutionPlan }) => void;
  onRemoteSessionRetry?: () => Promise<RequestExecutionPlan> | RequestExecutionPlan;
  onPlanUpdated?: (plan: RequestExecutionPlan) => void;
  onMaxToolTurnsReached?: () => void;
  serializeError: (error: unknown) => string;
}

export interface RequestEngineResult {
  plan: RequestExecutionPlan;
  activeRemoteSessionId: string | null;
  fullText: string;
  inputTokens: number;
  outputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  done: boolean;
}

export class RequestEngine {
  public async run(
    input: RequestEngineInput,
    callbacks: RequestEngineCallbacks,
  ): Promise<RequestEngineResult> {
    let currentPlan = input.plan;
    let activeRemoteSessionId = currentPlan.remoteSessionId;
    let fullText = '';
    let requestInputTokens = 0;
    let requestOutputTokens = 0;
    let requestUncachedInputTokens = 0;
    let requestCachedInputTokens = 0;
    let requestCacheWriteInputTokens = 0;
    let done = false;
    let attempt = 0;

    while (!input.signal.aborted) {
      const apiMessages = [...currentPlan.apiMessages];
      done = false;
      let toolTurns = 0;

      try {
        while (!input.signal.aborted && !done) {
          if (toolTurns >= input.maxToolTurns) {
            fullText = '[error] Maximum tool turns reached';
            done = true;
            callbacks.onMaxToolTurnsReached?.();
            break;
          }

          const apiCallStartedAt = Date.now();
          await callbacks.beforeApiCall?.({
            provider: input.provider,
            model: input.model,
            sessionId: input.sessionId,
            remoteSessionId: currentPlan.remoteSessionId,
            requestMode: currentPlan.mode,
            toolTurn: toolTurns,
            cwd: input.cwd,
          });

          const stream = input.client.stream(apiMessages, {
            systemPrompt: input.systemPrompt,
            model: input.model,
            tools: input.tools,
            signal: input.signal,
            maxTokens: input.maxTokens,
            remoteSessionId: currentPlan.remoteSessionId ?? undefined,
            cwd: input.cwd,
          });

          const outcome = await callbacks.consumeStream({
            stream,
            apiMessages,
            currentText: fullText,
            requestInputTokens,
            requestOutputTokens,
            requestUncachedInputTokens,
            requestCachedInputTokens,
            requestCacheWriteInputTokens,
            signal: input.signal,
            onSession: (sessionId: string) => {
              activeRemoteSessionId = sessionId;
              callbacks.onSessionObserved?.({
                sessionId,
                phase: 'stream',
                plan: currentPlan,
              });
            },
          });

          fullText = outcome.fullText;
          requestInputTokens = outcome.inputTokens;
          requestOutputTokens = outcome.outputTokens;
          requestUncachedInputTokens = outcome.uncachedInputTokens;
          requestCachedInputTokens = outcome.cachedInputTokens;
          requestCacheWriteInputTokens = outcome.cacheWriteInputTokens;
          done = outcome.done;

          await callbacks.afterApiCall?.({
            provider: input.provider,
            model: input.model,
            sessionId: input.sessionId,
            remoteSessionId: activeRemoteSessionId,
            requestMode: currentPlan.mode,
            toolTurn: toolTurns,
            continuedWithTools: outcome.continueWithTools,
            done: outcome.done,
            inputTokens: outcome.inputTokens,
            outputTokens: outcome.outputTokens,
            durationMs: Date.now() - apiCallStartedAt,
            cwd: input.cwd,
          });

          if (!outcome.continueWithTools || input.signal.aborted) {
            break;
          }

          toolTurns += 1;
        }

        break;
      } catch (error: unknown) {
        await callbacks.afterApiCall?.({
          provider: input.provider,
          model: input.model,
          sessionId: input.sessionId,
          remoteSessionId: activeRemoteSessionId,
          requestMode: currentPlan.mode,
          toolTurn: toolTurns,
          error: callbacks.serializeError(error),
          cwd: input.cwd,
        });

        if (currentPlan.remoteSessionId && attempt === 0 && !input.signal.aborted && callbacks.onRemoteSessionRetry) {
          currentPlan = await callbacks.onRemoteSessionRetry();
          callbacks.onPlanUpdated?.(currentPlan);
          fullText = '';
          requestInputTokens = 0;
          requestOutputTokens = 0;
          requestUncachedInputTokens = 0;
          requestCachedInputTokens = 0;
          requestCacheWriteInputTokens = 0;
          activeRemoteSessionId = currentPlan.remoteSessionId;
          attempt += 1;
          continue;
        }

        throw error;
      }
    }

    if (!input.signal.aborted && input.capabilities.supportsRemoteSession && activeRemoteSessionId) {
      callbacks.onSessionObserved?.({
        sessionId: activeRemoteSessionId,
        phase: 'final',
        plan: currentPlan,
      });
    }

    return {
      plan: currentPlan,
      activeRemoteSessionId,
      fullText,
      inputTokens: requestInputTokens,
      outputTokens: requestOutputTokens,
      uncachedInputTokens: requestUncachedInputTokens,
      cachedInputTokens: requestCachedInputTokens,
      cacheWriteInputTokens: requestCacheWriteInputTokens,
      done,
    };
  }
}
