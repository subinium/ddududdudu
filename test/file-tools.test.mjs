import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { editFileTool, readFileTool } from '../dist/tools/file-tools.js';
import { bashTool } from '../dist/tools/bash-tool.js';

test('editFileTool supports replace_all with expected replacement count', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-file-tools-'));
  const filePath = resolve(root, 'sample.txt');
  try {
    await writeFile(filePath, 'alpha\nbeta\nalpha\n', 'utf8');
    const result = await editFileTool.execute(
      {
        path: 'sample.txt',
        mode: 'replace_all',
        oldString: 'alpha',
        newString: 'omega',
        expectedReplacements: 2,
      },
      { cwd: root },
    );

    assert.equal(result.isError, undefined);
    assert.equal((await readFile(filePath, 'utf8')), 'omega\nbeta\nomega\n');
    assert.equal(result.metadata?.replacements, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('editFileTool supports range replacement and insert_after', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-file-tools-'));
  const filePath = resolve(root, 'sample.txt');
  try {
    await writeFile(filePath, 'one\ntwo\nthree\n', 'utf8');
    const range = await editFileTool.execute(
      {
        path: 'sample.txt',
        mode: 'range',
        startLine: 2,
        endLine: 3,
        newString: 'middle\nend',
      },
      { cwd: root },
    );
    assert.equal(range.isError, undefined);
    assert.equal((await readFile(filePath, 'utf8')), 'one\nmiddle\nend\n');

    const insert = await editFileTool.execute(
      {
        path: 'sample.txt',
        mode: 'insert_after',
        line: 1,
        newString: 'inserted',
      },
      { cwd: root },
    );
    assert.equal(insert.isError, undefined);
    assert.equal((await readFile(filePath, 'utf8')), 'one\ninserted\nmiddle\nend\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readFileTool supports explicit ranges and match windows', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-file-tools-'));
  const filePath = resolve(root, 'sample.txt');
  try {
    await writeFile(
      filePath,
      'one\nalpha target\nthree\nfour\nalpha again\nsix\n',
      'utf8',
    );

    const range = await readFileTool.execute(
      {
        path: 'sample.txt',
        startLine: 2,
        endLine: 4,
      },
      { cwd: root },
    );
    assert.equal(range.isError, undefined);
    assert.match(range.output, /^2: alpha target/m);
    assert.match(range.output, /^4: four/m);
    assert.equal(range.metadata?.mode, 'range');

    const match = await readFileTool.execute(
      {
        path: 'sample.txt',
        match: 'alpha',
        before: 0,
        after: 1,
      },
      { cwd: root },
    );
    assert.equal(match.isError, undefined);
    assert.match(match.output, /-- match 1 at line 2 --/);
    assert.match(match.output, /-- match 2 at line 5 --/);
    assert.equal(match.metadata?.mode, 'match');
    assert.equal(match.metadata?.matchCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readFileTool uses LSP symbols to narrow reads', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-file-tools-'));
  const filePath = resolve(root, 'sample.ts');
  try {
    await writeFile(
      filePath,
      'const a = 1;\n\nfunction targetFn() {\n  return a + 1;\n}\n\nconsole.log(targetFn());\n',
      'utf8',
    );

    const result = await readFileTool.execute(
      {
        path: 'sample.ts',
        symbol: 'targetFn',
      },
      {
        cwd: root,
        lsp: {
          async documentSymbols(requestPath) {
            assert.equal(requestPath, filePath);
            return [
              {
                name: 'targetFn',
                filePath,
                range: {
                  start: { line: 2, character: 0 },
                  end: { line: 4, character: 1 },
                },
                selectionRange: {
                  start: { line: 2, character: 9 },
                  end: { line: 2, character: 17 },
                },
              },
            ];
          },
        },
      },
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.metadata?.mode, 'symbol');
    assert.equal(result.metadata?.matchedSymbol, 'targetFn');
    assert.match(result.output, /^3: function targetFn\(\)/m);
    assert.match(result.output, /^5: }/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bashTool returns structured metadata for safe commands', async () => {
  const result = await bashTool.execute(
    { command: 'printf "hello world"' },
    { cwd: process.cwd() },
  );

  assert.equal(result.isError, false);
  assert.equal(result.metadata?.class, 'shell');
  assert.equal(result.metadata?.command, 'printf "hello world"');
  assert.match(String(result.metadata?.summary ?? ''), /hello world/);
});
