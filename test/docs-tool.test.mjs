import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { docsLookupTool } from '../dist/tools/docs-tool.js';

const createDocsFixture = async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-docs-tool-'));
  await mkdir(resolve(root, '.ddudu'), { recursive: true });
  await mkdir(resolve(root, 'docs'), { recursive: true });

  await writeFile(
    resolve(root, 'README.md'),
    '# Example Project\n\nThe flux capacitor bootstrap runs through the control loop.\n',
    'utf8',
  );
  await writeFile(
    resolve(root, 'AGENTS.md'),
    '# Repository instructions\n\nAlways verify the cobalt-reef rollout before shipping.\n',
    'utf8',
  );
  await writeFile(
    resolve(root, 'docs', 'setup.md'),
    '# Setup\n\nUse the neon garden deployment checklist before release.\n',
    'utf8',
  );
  await writeFile(
    resolve(root, '.ddudu', 'DDUDU.md'),
    '# Project instructions\n\nAlways protect the quartz-bridge migration path.\n',
    'utf8',
  );

  return root;
};

test('docs_lookup finds repository docs', async () => {
  const root = await createDocsFixture();
  try {
    const result = await docsLookupTool.execute(
      { query: 'flux capacitor bootstrap', scope: 'repo' },
      { cwd: root },
    );

    assert.equal(result.isError, undefined);
    assert.match(result.output, /\[repo\] README\.md:3/);
    assert.match(result.output, /flux capacitor bootstrap/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('docs_lookup finds project docs and instructions with scope filtering', async () => {
  const root = await createDocsFixture();
  try {
    const docs = await docsLookupTool.execute(
      { query: 'neon garden deployment', scope: 'docs' },
      { cwd: root },
    );
    assert.match(docs.output, /\[docs\] docs\/setup\.md:3/);

    const instructions = await docsLookupTool.execute(
      { query: 'quartz-bridge migration', scope: 'instructions' },
      { cwd: root },
    );
    assert.match(instructions.output, /\[instructions\] \.ddudu\/DDUDU\.md:3/);

    const sharedInstructions = await docsLookupTool.execute(
      { query: 'cobalt-reef rollout', scope: 'instructions' },
      { cwd: root },
    );
    assert.match(sharedInstructions.output, /\[instructions\] AGENTS\.md:3/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('docs_lookup reports when no local docs match', async () => {
  const root = await createDocsFixture();
  try {
    const result = await docsLookupTool.execute(
      { query: 'nonexistent hyperdrive sequence', scope: 'all' },
      { cwd: root },
    );
    assert.match(result.output, /No local documentation matches/);
    assert.equal(result.metadata?.count, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
