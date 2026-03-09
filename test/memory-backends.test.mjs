import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { registerMemoryBackend } from '../dist/core/memory-backends.js';
import { loadSelectedMemory, saveMemory } from '../dist/core/memory.js';

test('memory backend can be selected through config and swapped without changing callers', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-memory-backend-'));
  const previousCwd = process.cwd();
  process.chdir(root);

  try {
    const projectDir = resolve(root, '.ddudu');
    await mkdir(projectDir, { recursive: true });
    await writeFile(resolve(projectDir, 'config.yaml'), 'memory:\n  backend: fixture\n', 'utf8');

    registerMemoryBackend('fixture', () => ({
      name: 'fixture',
      async loadScopes(_cwd, scopes) {
        return scopes.map((scope) => ({
          scope,
          content: `fixture:${scope}`,
        }));
      },
      async save() {},
      async append() {},
      async clear() {},
    }));

    const selected = await loadSelectedMemory(root, ['working', 'semantic'], 200);
    assert.match(selected, /fixture:working/);
    assert.match(selected, /fixture:semantic/);

    await saveMemory(root, 'noop', 'project');
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
