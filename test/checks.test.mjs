import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChecksRunner } from '../dist/core/checks.js';

const makeTempDir = async () => {
  return mkdtemp(join(tmpdir(), 'checks-runner-'));
};

const writeCheckFile = async (rootDir, relativePath, content) => {
  const fullPath = join(rootDir, relativePath);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
  return fullPath;
};

describe('ChecksRunner', () => {
  it('scan parses frontmatter fields and defaults invalid severity to medium', async () => {
    const rootDir = await makeTempDir();
    await writeCheckFile(
      rootDir,
      '.agents/checks/security.md',
      `---
name: Security Sweep
description: Basic security review
severity-default: CRITICAL
tools:
  - grep
  - read_file
---
Look for dangerous patterns.
`,
    );
    await writeCheckFile(
      rootDir,
      '.ddudu/checks/perf.md',
      `---
severity-default: unknown
tools: [  ]
---
Review async loops.
`,
    );

    const runner = new ChecksRunner(rootDir);
    const checks = await runner.scan();
    const perf = checks.find((check) => check.name === 'perf');
    const security = checks.find((check) => check.name === 'Security Sweep');

    assert.equal(checks.length, 2);
    assert.ok(perf);
    assert.equal(perf.severity, 'medium');
    assert.deepEqual(perf.tools, []);
    assert.ok(security);
    assert.equal(security.severity, 'critical');
    assert.deepEqual(security.tools, ['grep', 'read_file']);
  });

  it('runCheck fallback detects security, performance, debug, and TODO/FIXME markers', async () => {
    const runner = new ChecksRunner(process.cwd());
    const check = {
      name: 'Security and Performance',
      description: 'security performance baseline',
      severity: 'high',
      tools: [],
      instructions: 'Review diff.',
      path: '/tmp/security.md',
    };
    const diff = `
+++ b/src/example.ts
eval(userInput)
items.forEach(async (item) => await process(item));
console.log('debug')
debugger;
// TODO: remove this
// FIXME: make safer
`;

    const result = await runner.runCheck(check, diff);

    assert.equal(result.passed, false);
    assert.ok(result.findings.some((f) => f.includes('eval(...)')));
    assert.ok(result.findings.some((f) => f.includes('forEach')));
    assert.ok(result.findings.some((f) => f.includes('console.log')));
    assert.ok(result.findings.some((f) => f.includes('Debugger statement')));
    assert.ok(result.findings.some((f) => f.includes('TODO/FIXME')));
  });

  it('runCheck fallback passes when diff has no heuristic findings', async () => {
    const runner = new ChecksRunner(process.cwd());
    const check = {
      name: 'General Review',
      description: 'style and quality',
      severity: 'medium',
      tools: [],
      instructions: 'Review diff.',
      path: '/tmp/general.md',
    };
    const diff = `
+++ b/src/clean.ts
const total = values.reduce((sum, value) => sum + value, 0);
return total;
`;

    const result = await runner.runCheck(check, diff);
    assert.equal(result.passed, true);
    assert.deepEqual(result.findings, []);
  });

  it('runAllChecks uses changed files from diff to select applicable checks', async () => {
    const rootDir = await makeTempDir();
    await writeCheckFile(
      rootDir,
      '.agents/checks/security.md',
      `---
name: Security Gate
severity-default: low
---
Root scope.
`,
    );
    await writeCheckFile(
      rootDir,
      'packages/app/.agents/checks/perf.md',
      `---
name: Perf Gate
severity-default: medium
---
Deeper scope.
`,
    );

    const runner = new ChecksRunner(rootDir);
    const diff = `
+++ b/packages/app/src/index.ts
eval(input)
`;

    const report = await runner.runAllChecks(diff);
    const names = report.checks.map((check) => check.checkName).sort();

    assert.deepEqual(names, ['Perf Gate', 'Security Gate']);
    assert.equal(report.summary, '1/2 checks failed.');
  });

  it('runAllChecks prefers .ddudu check over .agents at same scope and summarizes failures', async () => {
    const rootDir = await makeTempDir();
    await writeCheckFile(
      rootDir,
      '.agents/checks/review.md',
      `---
name: Shared Rule
severity-default: low
---
Agent check.
`,
    );
    await writeCheckFile(
      rootDir,
      '.ddudu/checks/review.md',
      `---
name: Shared Rule
severity-default: high
---
Project check.
`,
    );

    const runner = new ChecksRunner(rootDir);
    const diff = `
+++ b/src/main.ts
console.log('left in')
`;

    const report = await runner.runAllChecks(diff);

    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].severity, 'high');
    assert.equal(report.summary, '1/1 checks failed.');
  });

  it('formatReport renders both empty and populated reports', () => {
    const runner = new ChecksRunner(process.cwd());
    const empty = runner.formatReport({
      checks: [],
      summary: 'All 0 checks passed.',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    assert.match(empty, /No checks were discovered\./);

    const populated = runner.formatReport({
      checks: [
        {
          checkName: 'Security Gate',
          severity: 'critical',
          findings: ['Potential security issue: eval(...) found in diff.'],
          passed: false,
        },
      ],
      summary: '1/1 checks failed.',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    assert.match(populated, /\[FAIL\] Security Gate \(critical\)/);
    assert.match(populated, /Potential security issue: eval/);
  });
});
