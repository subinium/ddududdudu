import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { appendMemory, loadSelectedMemory } from '../dist/core/memory.js';

test('loadSelectedMemory returns only requested scopes and clips long content', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-memory-'));
  const previousCwd = process.cwd();
  process.chdir(root);

  try {
    await appendMemory(root, 'working-note', 'working');
    await appendMemory(root, 'semantic-note', 'semantic');
    await appendMemory(root, 'procedural-note '.repeat(80), 'procedural');

    const selected = await loadSelectedMemory(root, ['working', 'procedural'], 120);
    assert.match(selected, /Working Memory/);
    assert.match(selected, /Procedural Memory/);
    assert.doesNotMatch(selected, /Semantic Memory/);
    assert.ok(selected.length < 500);
    assert.match(selected, /…/);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
