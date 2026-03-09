import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  deleteDduduConfigValue,
  readDduduConfigOverride,
  setDduduConfigValue,
} from '../dist/core/config-editor.js';

test('config editor persists nested tool and MCP settings in project config', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-config-editor-'));
  const previousCwd = process.cwd();
  process.chdir(root);

  try {
    await setDduduConfigValue(root, 'tools.policies.bash', 'deny');
    await setDduduConfigValue(root, 'tools.network.allowed_hosts', ['docs.anthropic.com']);
    await setDduduConfigValue(root, 'tools.secrets.protected_env', ['OPENAI_API_KEY']);
    await setDduduConfigValue(root, 'mcp.servers.demo', {
      command: 'npx',
      args: ['-y', '@demo/server'],
      enabled: false,
      trust: 'ask',
    });

    const config = await readDduduConfigOverride(root);
    assert.equal(config.tools?.policies?.bash, 'deny');
    assert.deepEqual(config.tools?.network?.allowed_hosts, ['docs.anthropic.com']);
    assert.deepEqual(config.tools?.secrets?.protected_env, ['OPENAI_API_KEY']);
    assert.equal(config.mcp?.servers?.demo?.command, 'npx');
    assert.deepEqual(config.mcp?.servers?.demo?.args, ['-y', '@demo/server']);
    assert.equal(config.mcp?.servers?.demo?.enabled, false);
    assert.equal(config.mcp?.servers?.demo?.trust, 'ask');

    await deleteDduduConfigValue(root, 'tools.policies.bash');
    const updated = await readDduduConfigOverride(root);
    assert.equal(updated.tools?.policies?.bash, undefined);

    const raw = await readFile(resolve(root, '.ddudu/config.yaml'), 'utf8');
    assert.match(raw, /mcp:/);
    assert.match(raw, /demo:/);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
