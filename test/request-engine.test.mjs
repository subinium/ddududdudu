import test from 'node:test';
import assert from 'node:assert/strict';

import { RequestEngine } from '../dist/tui/native/request-engine.js';

test('RequestEngine retries once when a remote session plan fails and then succeeds', async () => {
  const engine = new RequestEngine();
  let consumeCalls = 0;
  let retryCalls = 0;
  const afterApiCallEvents = [];
  const observedSessions = [];

  const client = {
    capabilities: {
      executionMode: 'cli',
      supportsApiToolCalls: false,
      supportsToolState: true,
      supportsRemoteSession: true,
    },
    async *stream() {
      yield { type: 'text', text: '' };
    },
  };

  const result = await engine.run(
    {
      client,
      capabilities: client.capabilities,
      provider: 'openai',
      model: 'gpt-5.4',
      sessionId: 'session-1',
      cwd: '/tmp/project',
      plan: {
        apiMessages: [],
        mode: 'resume',
        note: null,
        remoteSessionId: 'remote-1',
      },
      systemPrompt: 'system',
      maxTokens: 1024,
      maxToolTurns: 4,
      signal: new AbortController().signal,
    },
    {
      beforeApiCall: () => undefined,
      afterApiCall: (input) => {
        afterApiCallEvents.push(input);
      },
      consumeStream: async ({ onSession }) => {
        consumeCalls += 1;
        if (consumeCalls === 1) {
          throw new Error('resume failed');
        }

        onSession?.('remote-2');
        return {
          fullText: 'done',
          inputTokens: 11,
          outputTokens: 7,
          uncachedInputTokens: 11,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          done: true,
          continueWithTools: false,
        };
      },
      onSessionObserved: (input) => {
        observedSessions.push(input);
      },
      onRemoteSessionRetry: async () => {
        retryCalls += 1;
        return {
          apiMessages: [],
          mode: 'fresh',
          note: null,
          remoteSessionId: null,
        };
      },
      onPlanUpdated: () => undefined,
      onMaxToolTurnsReached: () => undefined,
      serializeError: (error) => (error instanceof Error ? error.message : String(error)),
    },
  );

  assert.equal(retryCalls, 1);
  assert.equal(consumeCalls, 2);
  assert.equal(result.plan.mode, 'fresh');
  assert.equal(result.activeRemoteSessionId, 'remote-2');
  assert.equal(result.fullText, 'done');
  assert.equal(afterApiCallEvents.length, 2);
  assert.equal(afterApiCallEvents[0]?.error, 'resume failed');
  assert.equal(afterApiCallEvents[1]?.done, true);
  assert.equal(observedSessions[0]?.sessionId, 'remote-2');
  assert.equal(observedSessions[0]?.phase, 'stream');
  assert.equal(observedSessions[1]?.phase, 'final');
});
