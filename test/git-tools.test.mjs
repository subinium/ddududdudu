import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { gitDiffTool, gitStatusTool, patchApplyTool } from '../dist/tools/git-tools.js';

const execFileAsync = promisify(execFile);

const runGit = async (cwd, args) => {
  await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
};

const createRepo = async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-git-tools-'));
  await runGit(root, ['init']);
  await runGit(root, ['config', 'user.name', 'ddudu']);
  await runGit(root, ['config', 'user.email', 'ddudu@example.com']);
  return root;
};

test('git_status and git_diff report working tree changes', async () => {
  const root = await createRepo();
  const filePath = resolve(root, 'note.txt');
  try {
    await writeFile(filePath, 'hello\n', 'utf8');
    await runGit(root, ['add', 'note.txt']);
    await runGit(root, ['commit', '-m', 'init']);

    await writeFile(filePath, 'hello\nworld\n', 'utf8');

    const status = await gitStatusTool.execute({}, { cwd: root });
    assert.equal(status.isError, undefined);
    assert.match(status.output, /M note\.txt/);
    assert.equal(status.metadata?.counts?.modified, 1);

    const diff = await gitDiffTool.execute({}, { cwd: root });
    assert.equal(diff.isError, undefined);
    assert.match(diff.output, /\+world/);
    assert.deepEqual(diff.metadata?.files, ['note.txt']);
    assert.equal(diff.metadata?.fileCount, 1);
    assert.equal(diff.metadata?.insertions, 1);
    assert.equal(diff.metadata?.deletions, 0);
    assert.match(String(diff.metadata?.summary ?? ''), /1 file changed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('patch_apply validates and applies a patch', async () => {
  const root = await createRepo();
  const filePath = resolve(root, 'note.txt');
  try {
    await writeFile(filePath, 'hello\n', 'utf8');
    await runGit(root, ['add', 'note.txt']);
    await runGit(root, ['commit', '-m', 'init']);

    await writeFile(filePath, 'hello\nworld\n', 'utf8');
    const { stdout: patch } = await execFileAsync(
      'git',
      ['diff', '--no-ext-diff', '--minimal', '--', 'note.txt'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    await writeFile(filePath, 'hello\n', 'utf8');

    const check = await patchApplyTool.execute(
      { patch, check: true },
      { cwd: root },
    );
    assert.equal(check.isError, undefined);
    assert.match(check.output, /Patch check passed/);
    assert.deepEqual(check.metadata?.files, ['note.txt']);
    assert.equal(check.metadata?.fileCount, 1);

    const apply = await patchApplyTool.execute(
      { patch },
      { cwd: root },
    );
    assert.equal(apply.isError, undefined);
    assert.match(apply.output, /Patch applied successfully/);
    assert.deepEqual(apply.metadata?.files, ['note.txt']);
    assert.equal(apply.metadata?.fileCount, 1);
    assert.equal(await readFile(filePath, 'utf8'), 'hello\nworld\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
