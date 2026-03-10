import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowStateStore } from '../dist/tui/native/workflow-state-store.js';

test('WorkflowStateStore parses workflow snapshots without dropping cancelled jobs or blocked checklist items', () => {
  const store = new WorkflowStateStore();
  const snapshot = store.parseSnapshot({
    type: 'message',
    timestamp: '2026-03-10T00:00:00.000Z',
    data: {
      kind: 'controller_state',
      controllerState: {
        version: 1,
        mode: 'jennie',
        selectedModels: {
          jennie: 'gpt-5.4',
          lisa: 'gpt-5.4',
          'rosé': 'claude-sonnet-4-6',
          jisoo: 'gemini-2.5-pro',
        },
        permissionProfile: 'workspace-write',
        todos: [],
        remoteSessions: [],
        artifacts: [],
        queuedPrompts: [],
        backgroundJobs: [
          {
            id: 'job-1',
            kind: 'delegate',
            label: 'delegate',
            status: 'cancelled',
            detail: 'cancelled by user',
            startedAt: 1,
            updatedAt: 2,
            finishedAt: 3,
            checklist: [
              {
                id: 'verify',
                label: 'verify',
                owner: 'reviewer',
                status: 'blocked',
                detail: 'waiting on execute',
                dependsOn: ['execute'],
                handoffTo: 'reviewer',
                updatedAt: 2,
              },
            ],
          },
        ],
      },
    },
  }, {
    fallbackMode: 'jennie',
    fallbackSelectedModels: {
      jennie: 'claude-opus-4-6',
      lisa: 'gpt-5.4',
      'rosé': 'claude-sonnet-4-6',
      jisoo: 'gemini-2.5-pro',
    },
    fallbackPermissionProfile: 'workspace-write',
    normalizePermissionProfile: (value) =>
      value === 'plan' || value === 'ask' || value === 'workspace-write' || value === 'permissionless'
        ? value
        : 'workspace-write',
  });

  assert.ok(snapshot);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.backgroundJobs[0]?.status, 'cancelled');
  assert.equal(snapshot.backgroundJobs[0]?.checklist?.[0]?.status, 'blocked');
  assert.deepEqual(snapshot.backgroundJobs[0]?.checklist?.[0]?.dependsOn, ['execute']);
  assert.equal(snapshot.backgroundJobs[0]?.checklist?.[0]?.handoffTo, 'reviewer');
});
