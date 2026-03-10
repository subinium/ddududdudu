import test from 'node:test';
import assert from 'node:assert/strict';

import { formatAgentActivityHeartbeat } from '../dist/tui/native/controller-support.js';

test('formatAgentActivityHeartbeat summarizes active subagent work for tool heartbeats', () => {
  const summary = formatAgentActivityHeartbeat({
    label: 'task',
    elapsedMs: 24_000,
    activities: [
      {
        id: 'a',
        label: 'Researcher',
        mode: 'rosé',
        purpose: 'research',
        status: 'running',
        detail: 'Inspecting auth and provider fallback paths',
        updatedAt: 24_000,
      },
      {
        id: 'b',
        label: 'Reviewer',
        mode: 'jennie',
        purpose: 'review',
        status: 'queued',
        detail: 'waiting for anthropic provider slot',
        updatedAt: 23_000,
      },
    ],
  });

  assert.match(summary, /^task · 24s · 1 running · 1 queued/);
  assert.match(summary, /Researcher: Inspecting auth and provider fallback/);
  assert.match(summary, /Reviewer: waiting for anthropic provider slot/);
});
