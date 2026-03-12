import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI_ENTRY = join(process.cwd(), 'dist/index.js');

test('session --help prints usage instead of failing', async () => {
  const { stdout } = await execFileAsync('node', [CLI_ENTRY, 'session', '--help'], {
    cwd: process.cwd(),
  });

  assert.match(stdout, /ddudu session list/);
  assert.match(stdout, /ddudu session resume/);
});

test('init --help does not create project scaffolding', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ddudu-help-'));
  const { stdout } = await execFileAsync('node', [CLI_ENTRY, 'init', '--help'], {
    cwd,
  });

  assert.match(stdout, /ddudu init/);

  await assert.rejects(
    access(join(cwd, '.ddudu'), constants.F_OK),
    /ENOENT/,
  );
});

test('config show redacts stored secrets', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ddudu-config-'));
  await mkdir(join(cwd, '.ddudu'), { recursive: true });
  await writeFile(
    join(cwd, '.ddudu', 'config.yaml'),
    [
      'auth:',
      '  providers:',
      '    codex:',
      '      token: super-secret-token',
      '      token_type: bearer',
      'oracle:',
      '  client_secret: top-secret',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync('node', [CLI_ENTRY, 'config', 'show'], {
    cwd,
    env: {
      ...process.env,
      HOME: cwd,
    },
  });

  assert.match(stdout, /token: "\[redacted\]"/);
  assert.match(stdout, /client_secret: "\[redacted\]"/);
  assert.match(stdout, /token_type: bearer/);
  assert.doesNotMatch(stdout, /super-secret-token/);
  assert.doesNotMatch(stdout, /top-secret/);
});
