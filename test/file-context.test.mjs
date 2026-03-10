import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { resolveFileContext } from '../dist/context/file-context.js';

test('resolveFileContext summarizes session mentions with workflow state and recent messages', async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), 'ddudu-file-context-'));
  try {
    const dduduDir = resolve(cwd, '.ddudu');
    const sessionDir = resolve(dduduDir, 'test-sessions');
    await mkdir(sessionDir, { recursive: true });

    await writeFile(
      resolve(dduduDir, 'config.yaml'),
      ['session:', '  directory: .ddudu/test-sessions'].join('\n'),
      'utf8',
    );

    const sessionPath = resolve(sessionDir, 'abc123.jsonl');
    const content = [
      JSON.stringify({
        type: 'header',
        timestamp: '2026-03-10T00:00:00.000Z',
        data: {
          id: 'abc123',
          createdAt: '2026-03-10T00:00:00.000Z',
          title: 'fallback session',
          provider: 'openai',
          model: 'gpt-5.4',
          metadata: {
            mode: 'jennie',
          },
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-03-10T00:01:00.000Z',
        data: {
          kind: 'controller_state',
          controllerState: {
            mode: 'jennie',
            artifacts: [
              { kind: 'patch', title: 'runtime binding fix' },
            ],
            backgroundJobs: [
              { status: 'running' },
              { status: 'cancelled' },
            ],
          },
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-03-10T00:02:00.000Z',
        data: {
          user: 'continue the fallback fix',
          assistant: 'patched the runtime binding flow',
        },
      }),
      '',
    ].join('\n');
    await writeFile(sessionPath, content, 'utf8');

    const summary = await resolveFileContext(
      {
        type: 'session',
        name: 'latest',
      },
      cwd,
    );

    assert.match(summary, /fallback session/);
    assert.match(summary, /provider: openai/);
    assert.match(summary, /mode: jennie/);
    assert.match(summary, /artifacts: patch: runtime binding fix/);
    assert.match(summary, /background: 1 running \| 1 cancelled/);
    assert.match(summary, /user: continue the fallback fix/);
    assert.match(summary, /assistant: patched the runtime binding flow/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
