import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { WorktreeManager } from '../dist/core/worktree-manager.js';

const execFileAsync = promisify(execFile);

const runGit = async (cwd, args) => {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  return stdout.trim();
};

test('WorktreeManager.applyToBase lands tracked and new files from an isolated workspace', async () => {
  const repoRoot = await mkdtemp(resolve(tmpdir(), 'ddudu-worktree-test-'));
  try {
    await runGit(repoRoot, ['init']);
    await runGit(repoRoot, ['config', 'user.name', 'ddudu-test']);
    await runGit(repoRoot, ['config', 'user.email', 'ddudu@test.local']);

    await writeFile(resolve(repoRoot, 'app.txt'), 'hello\n', 'utf8');
    await runGit(repoRoot, ['add', 'app.txt']);
    await runGit(repoRoot, ['commit', '-m', 'init']);

    const manager = new WorktreeManager(repoRoot, '.ddudu/test-worktrees');
    const workspace = await manager.create('repair-pass');
    assert.ok(workspace, 'expected an isolated workspace');

    await writeFile(resolve(workspace.path, 'app.txt'), 'hello fixed\n', 'utf8');
    await writeFile(resolve(workspace.path, 'new-file.txt'), 'fresh file\n', 'utf8');

    const result = await manager.applyToBase(workspace);
    assert.equal(result.applied, true);
    assert.equal(result.empty, false);

    assert.equal(await readFile(resolve(repoRoot, 'app.txt'), 'utf8'), 'hello fixed\n');
    assert.equal(await readFile(resolve(repoRoot, 'new-file.txt'), 'utf8'), 'fresh file\n');

    await manager.remove(workspace);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('WorktreeManager creates unique isolated worktrees for concurrent runs', async () => {
  const repoRoot = await mkdtemp(resolve(tmpdir(), 'ddudu-worktree-parallel-'));
  try {
    await runGit(repoRoot, ['init']);
    await runGit(repoRoot, ['config', 'user.name', 'ddudu-test']);
    await runGit(repoRoot, ['config', 'user.email', 'ddudu@test.local']);

    await writeFile(resolve(repoRoot, 'app.txt'), 'hello\n', 'utf8');
    await runGit(repoRoot, ['add', 'app.txt']);
    await runGit(repoRoot, ['commit', '-m', 'init']);

    const manager = new WorktreeManager(repoRoot, '.ddudu/test-worktrees');
    const first = await manager.create('parallel-worker');
    const second = await manager.create('parallel-worker');

    assert.ok(first, 'expected first isolated workspace');
    assert.ok(second, 'expected second isolated workspace');
    assert.notEqual(first.path, second.path);
    assert.notEqual(first.id, second.id);

    await manager.remove(first);
    await manager.remove(second);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('WorktreeManager.inspect reports whether an isolated workspace has changes', async () => {
  const repoRoot = await mkdtemp(resolve(tmpdir(), 'ddudu-worktree-inspect-'));
  try {
    await runGit(repoRoot, ['init']);
    await runGit(repoRoot, ['config', 'user.name', 'ddudu-test']);
    await runGit(repoRoot, ['config', 'user.email', 'ddudu@test.local']);

    await writeFile(resolve(repoRoot, 'app.txt'), 'hello\n', 'utf8');
    await runGit(repoRoot, ['add', 'app.txt']);
    await runGit(repoRoot, ['commit', '-m', 'init']);

    const manager = new WorktreeManager(repoRoot, '.ddudu/test-worktrees');
    const workspace = await manager.create('inspect-pass');
    assert.ok(workspace, 'expected isolated workspace');

    const clean = await manager.inspect(workspace);
    assert.equal(clean.hasChanges, false);

    await writeFile(resolve(workspace.path, 'app.txt'), 'dirty\n', 'utf8');
    const dirty = await manager.inspect(workspace);
    assert.equal(dirty.hasChanges, true);
    assert.match(dirty.summary, /app\.txt/);

    await manager.remove(workspace);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('WorktreeManager.cleanup removes isolated workspaces', async () => {
  const repoRoot = await mkdtemp(resolve(tmpdir(), 'ddudu-worktree-cleanup-'));
  try {
    await runGit(repoRoot, ['init']);
    await runGit(repoRoot, ['config', 'user.name', 'ddudu-test']);
    await runGit(repoRoot, ['config', 'user.email', 'ddudu@test.local']);

    await writeFile(resolve(repoRoot, 'app.txt'), 'hello\n', 'utf8');
    await runGit(repoRoot, ['add', 'app.txt']);
    await runGit(repoRoot, ['commit', '-m', 'init']);

    const manager = new WorktreeManager(repoRoot, '.ddudu/test-worktrees');
    const workspace = await manager.create('cleanup-pass');
    assert.ok(workspace, 'expected isolated workspace');

    const result = await manager.cleanup(workspace);
    assert.equal(result.attempted, true);
    assert.equal(result.removed, true);

    await assert.rejects(stat(workspace.path));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
