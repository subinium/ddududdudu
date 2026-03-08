import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildArtifactPayload,
  formatArtifactContextLine,
  formatArtifactForHandoff,
  formatArtifactForInspector,
} from '../dist/core/artifacts.js';

const verification = {
  status: 'failed',
  summary: 'failed · 1/3 checks flagged · 1/1 scripts failed',
  changedFiles: ['src/app.ts', 'src/view.ts'],
  commands: [
    {
      command: 'npm run --silent test',
      ok: false,
      exitCode: 1,
      output: 'tests failed',
    },
  ],
};

test('buildArtifactPayload extracts structured fields for patch artifacts', () => {
  const payload = buildArtifactPayload({
    kind: 'patch',
    purpose: 'execution',
    task: 'fix the sidebar spacing issue',
    summary: '- adjust spacing tokens\n- rerun tests\n- confirm render output',
    files: ['src/ui/sidebar.tsx'],
    verification,
    workspaceApply: {
      applied: true,
      empty: false,
      summary: '1 file changed, 3 insertions(+), 1 deletion(-)',
      path: '/tmp/worktree',
    },
  });

  assert.equal(payload?.purpose, 'execution');
  assert.deepEqual(payload?.files, ['src/ui/sidebar.tsx']);
  assert.ok(payload?.decisions?.includes('adjust spacing tokens'));
  assert.equal(payload?.verification?.status, 'failed');
  assert.equal(payload?.workspaceApply?.applied, true);
});

test('artifact formatters prefer structured payload over raw summary', () => {
  const artifact = {
    id: 'artifact-1',
    kind: 'review',
    title: 'Jennie review',
    summary: 'fallback summary',
    payload: {
      purpose: 'review',
      risks: ['sidebar progress is not visible'],
      verification: {
        status: 'failed',
        summary: 'failed · lint flagged one issue',
      },
    },
    source: 'delegate',
    mode: 'jennie',
    createdAt: new Date().toISOString(),
  };

  assert.match(formatArtifactContextLine(artifact), /\[review\] Jennie review/);
  assert.match(formatArtifactForHandoff(artifact), /risk: sidebar progress is not visible/);

  const inspector = formatArtifactForInspector(artifact).join('\n');
  assert.match(inspector, /source: delegate/);
  assert.match(inspector, /verification: failed · failed · lint flagged one issue/);
});
