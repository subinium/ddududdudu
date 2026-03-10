import test from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowStateStore } from '../dist/tui/native/workflow-state-store.js';

test('WorkflowStateStore.restoreSession reconstructs mode, messages, and snapshot state', () => {
  const store = new WorkflowStateStore();
  const restored = store.restoreSession(
    {
      header: {
        id: 'session-1',
        createdAt: '2026-03-10T00:00:00.000Z',
        provider: 'openai',
        model: 'gpt-5.4',
        metadata: {
          mode: 'jennie',
        },
      },
      entries: [
        {
          type: 'message',
          timestamp: '2026-03-10T00:01:00.000Z',
          data: {
            user: 'fix the workflow restore path',
            assistant: 'working on it',
          },
        },
        {
          type: 'message',
          timestamp: '2026-03-10T00:02:00.000Z',
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
              todos: [
                {
                  id: 'todo-1',
                  step: 'restore background jobs',
                  status: 'in_progress',
                  updatedAt: '2026-03-10T00:02:00.000Z',
                },
              ],
              remoteSessions: [
                {
                  provider: 'openai',
                  sessionId: 'remote-1',
                  syncedMessageCount: 2,
                  lastModel: 'gpt-5.4',
                  lastUsedAt: 100,
                },
              ],
              artifacts: [
                {
                  id: 'artifact-1',
                  kind: 'patch',
                  title: 'fallback fix',
                  summary: 'restored runtime binding',
                  source: 'session',
                  createdAt: '2026-03-10T00:02:00.000Z',
                },
              ],
              queuedPrompts: ['follow up'],
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
                      owner: null,
                      status: 'blocked',
                      detail: 'waiting on execute',
                      updatedAt: 2,
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    },
    {
      fallbackMode: 'lisa',
      fallbackSelectedModels: {
        jennie: 'claude-opus-4-6',
        lisa: 'gpt-5.4',
        'rosé': 'claude-sonnet-4-6',
        jisoo: 'gemini-2.5-pro',
      },
      fallbackPermissionProfile: 'ask',
      normalizePermissionProfile: (value) =>
        value === 'plan' || value === 'ask' || value === 'workspace-write' || value === 'permissionless'
          ? value
          : 'workspace-write',
    },
  );

  assert.equal(restored.sessionId, 'session-1');
  assert.equal(restored.mode, 'jennie');
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.permissionProfile, 'workspace-write');
  assert.equal(restored.todos[0]?.status, 'in_progress');
  assert.equal(restored.remoteSessions[0]?.provider, 'openai');
  assert.equal(restored.artifacts[0]?.kind, 'patch');
  assert.deepEqual(restored.queuedPrompts, ['follow up']);
  assert.equal(restored.backgroundJobs[0]?.status, 'cancelled');
  assert.equal(restored.backgroundJobs[0]?.checklist?.[0]?.status, 'blocked');
});
