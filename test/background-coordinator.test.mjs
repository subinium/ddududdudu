import test from 'node:test';
import assert from 'node:assert/strict';

import { BackgroundCoordinator } from '../dist/tui/native/background-coordinator.js';

test('BackgroundCoordinator maps stored jobs and detects terminal transitions', async () => {
  const coordinator = new BackgroundCoordinator({
    previewText: (value) => value,
    formatChecklistLinkedDetail: (_checklist, checklistId, detail) =>
      checklistId ? `${checklistId}:${detail ?? ''}` : detail ?? null,
  });

  let calls = 0;
  coordinator.setStore({
    async listBySession() {
      calls += 1;
      if (calls === 1) {
        return [
          {
            id: 'job-1',
            kind: 'delegate',
            label: 'delegate',
            status: 'queued',
            detail: null,
            createdAt: 1,
            updatedAt: 1,
            prompt: 'run it',
            purpose: 'execution',
            preferredMode: 'lisa',
            strategy: null,
            reason: null,
            attempt: 0,
            checklist: [],
            agentActivities: [],
            result: null,
            artifact: null,
          },
        ];
      }

      return [
        {
          id: 'job-1',
          kind: 'delegate',
          label: 'delegate',
          status: 'done',
          detail: 'finished',
          createdAt: 1,
          updatedAt: 2,
          finishedAt: 2,
          prompt: 'run it',
          purpose: 'execution',
          preferredMode: 'lisa',
          strategy: null,
          reason: null,
          attempt: 0,
          checklist: [],
          agentActivities: [],
          result: {
            text: 'patched',
            provider: 'openai',
            model: 'gpt-5.4',
          },
          artifact: null,
        },
      ];
    },
  });

  const first = await coordinator.pollSession('session-1');
  assert.equal(first.jobs[0]?.status, 'running');
  assert.equal(first.transitioned.length, 0);

  const second = await coordinator.pollSession('session-1');
  assert.equal(second.jobs[0]?.status, 'done');
  assert.equal(second.transitioned.length, 1);
  assert.equal(second.transitioned[0]?.id, 'job-1');
});
