import test from 'node:test';
import assert from 'node:assert/strict';

import { runTeamAgentDelegation } from '../dist/core/team-execution.js';

test('runTeamAgentDelegation builds a consistent delegation request for team agents', async () => {
  let capturedRequest = null;
  let callbacks = null;

  const runtime = {
    async run(request, handlers) {
      capturedRequest = request;
      callbacks = handlers;
      handlers.onText?.('working');
      handlers.onExecutionState?.('waiting for slot');
      handlers.onVerificationState?.({ status: 'running', summary: 'checks running' });
      return {
        text: 'Implemented the change',
        mode: 'lisa',
        provider: 'openai',
        model: 'gpt-5.4',
        purpose: 'execution',
        cwd: '/tmp/project',
        usage: {
          input: 12,
          output: 8,
        },
        durationMs: 42,
      };
    },
  };

  const seen = [];
  const result = await runTeamAgentDelegation({
    runtime,
    agent: {
      id: 'worker-1',
      name: 'Worker',
      role: 'worker',
      roleProfile: 'executor',
      mode: 'lisa',
      provider: 'openai',
      model: 'gpt-5.4',
      systemPrompt: 'Implement it.',
      taskLabel: 'Implement the feature',
      readOnly: false,
    },
    input: 'Apply the requested change',
    round: 2,
    signal: new AbortController().signal,
    maxTokens: 777,
    parentSessionId: 'session-1',
    cwd: '/tmp/project',
    contextSnapshot: 'snapshot',
    artifacts: [],
    onText: (delta) => seen.push(`text:${delta}`),
    onExecutionState: (detail) => seen.push(`exec:${detail}`),
    onVerificationState: (state) => seen.push(`verify:${state.status}`),
  });

  assert.equal(capturedRequest?.purpose, 'execution');
  assert.equal(capturedRequest?.preferredMode, 'lisa');
  assert.equal(capturedRequest?.preferredModel, 'gpt-5.4');
  assert.equal(capturedRequest?.verificationMode, 'checks');
  assert.equal(capturedRequest?.parentSessionId, 'session-1');
  assert.match(capturedRequest?.prompt ?? '', /Round 2/);
  assert.match(capturedRequest?.prompt ?? '', /Apply the requested change/);
  assert.equal(result.output, 'Implemented the change');
  assert.ok(callbacks);
  assert.deepEqual(seen, ['text:working', 'exec:waiting for slot', 'verify:running']);
});

test('runTeamAgentDelegation keeps research specialists read-only and skips verification', async () => {
  let capturedRequest = null;

  const runtime = {
    async run(request) {
      capturedRequest = request;
      return {
        text: 'Collected the research notes',
        mode: 'rosé',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        purpose: 'research',
        cwd: '/tmp/project',
        usage: {
          input: 9,
          output: 7,
        },
        durationMs: 21,
      };
    },
  };

  await runTeamAgentDelegation({
    runtime,
    agent: {
      id: 'worker-2',
      name: 'Researcher',
      role: 'worker',
      roleProfile: 'explorer',
      mode: 'rosé',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'Research it.',
      taskLabel: 'Research omo',
      readOnly: true,
    },
    input: 'Investigate omo',
    round: 1,
    signal: new AbortController().signal,
    cwd: '/tmp/project',
    contextSnapshot: 'snapshot',
    artifacts: [],
  });

  assert.equal(capturedRequest?.purpose, 'research');
  assert.equal(capturedRequest?.verificationMode, 'none');
  assert.equal(capturedRequest?.readOnly, true);
});
