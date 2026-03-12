import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { initializeProject } from '../dist/core/project-init.js';

test('initializeProject scaffolds shared instructions and starter hooks', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-init-'));
  try {
    const result = await initializeProject(root);

    assert.equal(result.alreadyInitialized, false);
    assert.ok(result.created.includes('.ddudu/config.yaml'));
    assert.ok(result.created.includes('.ddudu/DDUDU.md'));
    assert.ok(result.created.includes('AGENTS.md'));
    assert.ok(result.created.includes('.ddudu/hooks/README.md'));
    assert.ok(result.created.includes('.ddudu/hooks/template-onSessionStart.mjs'));
    assert.ok(result.created.includes('.ddudu/hooks/template-afterResponse.mjs'));

    const agents = await readFile(resolve(root, 'AGENTS.md'), 'utf8');
    assert.match(agents, /Repository Instructions/);

    const hooksReadme = await readFile(resolve(root, '.ddudu', 'hooks', 'README.md'), 'utf8');
    assert.match(hooksReadme, /Rename a template/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('initializeProject is idempotent once starter pack exists', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-init-'));
  try {
    await initializeProject(root);
    const second = await initializeProject(root);

    assert.equal(second.alreadyInitialized, true);
    assert.deepEqual(second.created, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
