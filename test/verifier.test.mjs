import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { VerificationRunner } from '../dist/core/verifier.js';

const execFileAsync = promisify(execFile);

const runGit = async (cwd, args) => {
  await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
};

const writeFixtureFile = async (root, relativePath, content) => {
  const filePath = join(root, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return filePath;
};

const createRepoFixture = async (baselineFiles = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'ddudu-verifier-'));
  await runGit(root, ['init']);
  await runGit(root, ['config', 'user.name', 'ddudu']);
  await runGit(root, ['config', 'user.email', 'ddudu@example.com']);

  await writeFixtureFile(root, 'README.md', '# fixture\n');
  for (const [relativePath, content] of Object.entries(baselineFiles)) {
    await writeFixtureFile(root, relativePath, content);
  }

  await runGit(root, ['add', '-A']);
  await runGit(root, ['commit', '-m', 'init']);
  return root;
};

describe('VerificationRunner', () => {
  it('run(checks) returns skipped outside git repositories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ddudu-verifier-no-git-'));
    try {
      const runner = new VerificationRunner(root);
      const result = await runner.run('checks');

      assert.equal(result.status, 'skipped');
      assert.equal(result.summary, 'skipped · not a git repository');
      assert.equal(result.fingerprint, null);
      assert.deepEqual(result.changedFiles, []);
      assert.deepEqual(result.commands, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('run(checks) returns skipped when no diff is detected', async () => {
    const root = await createRepoFixture();
    try {
      const runner = new VerificationRunner(root);
      const result = await runner.run('checks');

      assert.equal(result.status, 'skipped');
      assert.equal(result.summary, 'skipped · no diff detected');
      assert.equal(result.fingerprint, null);
      assert.deepEqual(result.changedFiles, []);
      assert.deepEqual(result.commands, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('run(checks) returns passed when all checks pass', async () => {
    const root = await createRepoFixture({
      '.ddudu/checks/style.md': `---
name: Style Gate
severity-default: low
---
Review style.
`,
      'src/app.ts': 'export const value = 1;\n',
    });

    try {
      await writeFixtureFile(root, 'src/app.ts', 'export const value = 2;\n');

      const runner = new VerificationRunner(root);
      const result = await runner.run('checks');

      assert.equal(result.status, 'passed');
      assert.match(result.summary, /^passed · \d+ checks clean$/);
      assert.equal(result.commands.length, 0);
      assert.ok(result.fingerprint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('run(checks) extracts changed files from +++ b/path lines and deduplicates', async () => {
    const root = await createRepoFixture({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n',
    });

    try {
      await writeFixtureFile(root, 'src/a.ts', 'export const a = 2;\n');
      await writeFixtureFile(root, 'src/b.ts', 'export const b = 2;\n');

      const runner = new VerificationRunner(root);
      const result = await runner.run('checks');

      assert.deepEqual(result.changedFiles.sort(), ['src/a.ts', 'src/b.ts']);
      assert.match(result.report, /changed files: src\/a\.ts, src\/b\.ts|changed files: src\/b\.ts, src\/a\.ts/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('run(checks) returns failed when checks contain failures', async () => {
    const root = await createRepoFixture({
      '.ddudu/checks/security.md': `---
name: Security Gate
severity-default: high
---
Review for risky patterns.
`,
      'src/main.ts': 'export const main = () => 1;\n',
    });

    try {
      await writeFixtureFile(root, 'src/main.ts', 'export const main = () => {\n  console.log(\'debug\');\n  return 1;\n};\n');

      const runner = new VerificationRunner(root);
      const result = await runner.run('checks');

      assert.equal(result.status, 'failed');
      assert.match(result.summary, /^failed · 1\/1 checks flagged$/);
      assert.match(result.report, /Debug logging found in diff/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('run(checks) summary uses "passed · N checks clean" format', async () => {
    const root = await createRepoFixture({
      '.ddudu/checks/general.md': `---
name: General Gate
severity-default: medium
---
General review.
`,
      'lib/index.ts': 'export const sum = (a, b) => a + b;\n',
    });

    try {
      await writeFixtureFile(root, 'lib/index.ts', 'export const sum = (a, b) => a + b + 1;\n');

      const runner = new VerificationRunner(root);
      const result = await runner.run('checks');

      assert.equal(result.summary, 'passed · 1 checks clean');
      assert.equal(result.status, 'passed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('run(checks) includes changed files in report output', async () => {
    const root = await createRepoFixture({
      'docs/guide.md': 'hello\n',
    });

    try {
      await writeFixtureFile(root, 'docs/guide.md', 'hello\nworld\n');

      const runner = new VerificationRunner(root);
      const result = await runner.run('checks');

      assert.match(result.report, /changed files: docs\/guide\.md/);
      assert.deepEqual(result.changedFiles, ['docs/guide.md']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('run(full) executes lint, test, and build scripts and returns command results', async () => {
    const root = await createRepoFixture({
      'src/index.ts': 'export const value = 1;\n',
      'package.json': JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        scripts: {
          lint: 'node -e "console.log(\'lint clean\')"',
          test: 'node -e "console.error(\'FAIL sample.spec.ts:4 expected true\'); process.exit(1)"',
          build: 'node -e "console.log(\'build ok\')"',
        },
      }, null, 2),
    });

    try {
      await writeFixtureFile(root, 'src/index.ts', 'export const value = 2;\n');

      const runner = new VerificationRunner(root);
      const result = await runner.run('full');

      assert.equal(result.commands.length, 3);
      assert.deepEqual(result.commands.map((command) => command.kind), ['lint', 'test', 'build']);
      assert.match(result.report, /## Commands/);
      assert.match(result.report, /pass · lint/);
      assert.match(result.report, /fail · test/);
      assert.match(result.report, /pass · build/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('run(full) summary includes both check and script results', async () => {
    const root = await createRepoFixture({
      'src/index.ts': 'export const value = 1;\n',
      'package.json': JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        scripts: {
          lint: 'node -e "console.log(\'lint clean\')"',
          test: 'node -e "process.exit(1)"',
          build: 'node -e "console.log(\'build ok\')"',
        },
      }, null, 2),
    });

    try {
      await writeFixtureFile(root, 'src/index.ts', 'export const value = 2;\n');

      const runner = new VerificationRunner(root);
      const result = await runner.run('full');

      assert.equal(result.status, 'failed');
      assert.equal(result.summary, 'failed · 0 checks clean · 1/3 scripts failed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('run(full) previews long command output with trailing ellipsis', async () => {
    const longText = 'x'.repeat(500);
    const root = await createRepoFixture({
      'src/index.ts': 'export const value = 1;\n',
      'package.json': JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        scripts: {
          lint: `node -e "console.log('${longText}')"`,
        },
      }, null, 2),
    });

    try {
      await writeFixtureFile(root, 'src/index.ts', 'export const value = 2;\n');

      const runner = new VerificationRunner(root);
      const result = await runner.run('full');

      assert.equal(result.commands.length, 1);
      assert.equal(result.commands[0].kind, 'lint');
      assert.ok(result.commands[0].output.length <= 240);
      assert.ok(result.commands[0].output.endsWith('…'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
