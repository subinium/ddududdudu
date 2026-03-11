import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  deleteDduduConfigValue,
  readDduduConfigOverride,
  setDduduConfigValue,
} from '../dist/core/config-editor.js';

test('config editor persists nested settings in global config by default', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-config-editor-'));
  const projectRoot = resolve(root, 'project');
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  await mkdir(projectRoot, { recursive: true });
  process.chdir(projectRoot);

  try {
    await setDduduConfigValue(projectRoot, 'tools.policies.bash', 'deny');
    await setDduduConfigValue(projectRoot, 'memory.backend', 'file');
    await setDduduConfigValue(projectRoot, 'tools.network.allowed_hosts', ['docs.anthropic.com']);
    await setDduduConfigValue(projectRoot, 'tools.secrets.protected_env', ['OPENAI_API_KEY']);
    await setDduduConfigValue(projectRoot, 'mcp.servers.demo', {
      command: 'npx',
      args: ['-y', '@demo/server'],
      enabled: false,
      trust: 'ask',
    });

    const config = await readDduduConfigOverride(projectRoot);
    assert.equal(config.memory?.backend, 'file');
    assert.equal(config.tools?.policies?.bash, 'deny');
    assert.deepEqual(config.tools?.network?.allowed_hosts, ['docs.anthropic.com']);
    assert.deepEqual(config.tools?.secrets?.protected_env, ['OPENAI_API_KEY']);
    assert.equal(config.mcp?.servers?.demo?.command, 'npx');
    assert.deepEqual(config.mcp?.servers?.demo?.args, ['-y', '@demo/server']);
    assert.equal(config.mcp?.servers?.demo?.enabled, false);
    assert.equal(config.mcp?.servers?.demo?.trust, 'ask');

    await deleteDduduConfigValue(projectRoot, 'tools.policies.bash');
    const updated = await readDduduConfigOverride(projectRoot);
    assert.equal(updated.tools?.policies?.bash, undefined);

    const raw = await readFile(resolve(homedir(), '.ddudu/config.yaml'), 'utf8');
    assert.match(raw, /mcp:/);
    assert.match(raw, /demo:/);

    const projectConfigPath = resolve(projectRoot, '.ddudu/config.yaml');
    await assert.rejects(readFile(projectConfigPath, 'utf8'));
  } finally {
    process.env.HOME = previousHome;
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test('config editor still supports explicit project-scoped overrides', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-config-editor-project-'));
  const previousCwd = process.cwd();
  process.chdir(root);

  try {
    await setDduduConfigValue(root, 'memory.backend', 'file', 'project');
    const projectConfig = await readDduduConfigOverride(root, 'project');
    assert.equal(projectConfig.memory?.backend, 'file');

    const raw = await readFile(resolve(root, '.ddudu/config.yaml'), 'utf8');
    assert.match(raw, /memory:/);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
