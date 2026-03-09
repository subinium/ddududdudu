import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  buildRunnerTool,
  lintRunnerTool,
  testRunnerTool,
  verifyChangesTool,
} from '../dist/tools/verifier-tools.js';

const execFileAsync = promisify(execFile);

const runGit = async (cwd, args) => {
  await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
};

const createPackageFixture = async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-verifier-tools-'));
  await writeFile(
    resolve(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: {
        lint: 'node -e "console.log(\'lint clean\')"',
        test: 'node -e "console.error(\'FAIL sample.spec.ts:4 expected true\'); process.exit(1)"',
        build: 'node -e "console.log(\'build ok\')"',
      },
    }, null, 2),
    'utf8',
  );
  return root;
};

test('lint_runner and build_runner use package scripts with structured summaries', async () => {
  const root = await createPackageFixture();
  try {
    const lint = await lintRunnerTool.execute({}, { cwd: root });
    assert.equal(lint.isError, false);
    assert.equal(lint.metadata?.ok, true);
    assert.match(String(lint.metadata?.summary ?? ''), /lint passed/i);

    const build = await buildRunnerTool.execute({}, { cwd: root });
    assert.equal(build.isError, false);
    assert.equal(build.metadata?.ok, true);
    assert.match(String(build.output), /build ok/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('test_runner reports failures with highlights', async () => {
  const root = await createPackageFixture();
  try {
    const result = await testRunnerTool.execute({}, { cwd: root });
    assert.equal(result.isError, true);
    assert.equal(result.metadata?.ok, false);
    assert.match(String(result.metadata?.summary ?? ''), /test failed/i);
    assert.ok(Array.isArray(result.metadata?.highlights));
    assert.match(String(result.output), /FAIL sample\.spec\.ts:4/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('build_runner supports explicit command overrides', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-verifier-tools-'));
  try {
    const result = await buildRunnerTool.execute(
      { command: 'printf "custom build"' },
      { cwd: root },
    );
    assert.equal(result.isError, false);
    assert.equal(result.metadata?.ok, true);
    assert.match(String(result.output), /custom build/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verify_changes reports skipped outside git repositories', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-verifier-tools-'));
  try {
    const result = await verifyChangesTool.execute({}, { cwd: root });
    assert.equal(result.isError, false);
    assert.equal(result.metadata?.verification?.status, 'skipped');
    assert.match(String(result.output), /Status: skipped/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verify_changes can detect repository diffs', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-verifier-tools-'));
  try {
    await runGit(root, ['init']);
    await runGit(root, ['config', 'user.name', 'ddudu']);
    await runGit(root, ['config', 'user.email', 'ddudu@example.com']);
    await writeFile(resolve(root, 'note.txt'), 'hello\n', 'utf8');
    await runGit(root, ['add', 'note.txt']);
    await runGit(root, ['commit', '-m', 'init']);
    await writeFile(resolve(root, 'note.txt'), 'hello\nworld\n', 'utf8');

    const result = await verifyChangesTool.execute({ mode: 'checks' }, { cwd: root });
    assert.notEqual(result.metadata?.verification?.status, undefined);
    assert.match(String(result.output), /Changed files: note\.txt/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
