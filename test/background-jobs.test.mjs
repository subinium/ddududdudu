import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { BackgroundJobStore } from '../dist/core/background-jobs.js';

test('BackgroundJobStore persists retry counts and workspace apply metadata', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-job-store-'));
  try {
    const store = new BackgroundJobStore(resolve(root, 'jobs'));
    const record = await store.create({
      sessionId: 'session-1',
      kind: 'delegate',
      label: 'LISA execution',
      cwd: root,
      prompt: 'fix the failing test',
      purpose: 'execution',
      preferredMode: 'lisa',
      preferredModel: 'gpt-5.4',
      reason: 'manual retry',
      attempt: 2,
      verificationMode: 'checks',
      contextSnapshot: '<context_snapshot />',
      artifacts: [],
      teamAgents: [],
      teamSharedContext: null,
      agentActivities: [],
      result: {
        text: 'fixed',
        provider: 'openai',
        model: 'gpt-5.4',
        mode: 'lisa',
        workspacePath: '/tmp/worktree',
        workspaceApply: {
          applied: true,
          empty: false,
          summary: '1 file changed, 2 insertions(+), 1 deletion(-)',
        },
      },
      artifact: null,
    });

    const loaded = await store.load(record.id);
    assert.equal(loaded.attempt, 2);
    assert.equal(loaded.result?.workspaceApply?.applied, true);
    assert.match(loaded.result?.workspaceApply?.summary ?? '', /1 file changed/);

    const bySession = await store.listBySession('session-1');
    assert.equal(bySession.length, 1);
    assert.equal(bySession[0]?.id, record.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('BackgroundJobStore supports global job visibility across sessions', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-job-store-global-'));
  try {
    const store = new BackgroundJobStore(resolve(root, 'jobs'));
    const first = await store.create({
      sessionId: 'session-a',
      kind: 'delegate',
      label: 'first',
      cwd: root,
      prompt: 'first prompt',
      purpose: 'execution',
      preferredMode: 'lisa',
      preferredModel: 'gpt-5.4',
      reason: 'manual',
      attempt: 0,
      verificationMode: 'checks',
      contextSnapshot: null,
      artifacts: [],
      teamAgents: [],
      teamSharedContext: null,
      agentActivities: [],
      result: null,
      artifact: null,
    });
    const second = await store.create({
      sessionId: 'session-b',
      kind: 'delegate',
      label: 'second',
      cwd: root,
      prompt: 'second prompt',
      purpose: 'research',
      preferredMode: 'rosé',
      preferredModel: 'claude-opus-4-6',
      reason: 'manual',
      attempt: 1,
      verificationMode: 'checks',
      contextSnapshot: null,
      artifacts: [],
      teamAgents: [],
      teamSharedContext: null,
      agentActivities: [],
      result: null,
      artifact: null,
    });

    const allJobs = await store.list();
    assert.equal(allJobs.length, 2);
    assert.deepEqual(
      allJobs.map((job) => job.id).sort(),
      [first.id, second.id].sort(),
    );

    const sessionAJobs = await store.listBySession('session-a');
    assert.equal(sessionAJobs.length, 1);
    assert.equal(sessionAJobs[0]?.id, first.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
