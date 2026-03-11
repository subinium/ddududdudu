import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import {
  decidePromotion,
  dedupeAgainstExisting,
  mergeWithExisting,
  scoreCandidate,
  shouldReplace,
} from '../dist/core/memory-promotion.js';
import { getMemoryBackend } from '../dist/core/memory-backends.js';

test('scoreCandidate produces expected ranges for verified concrete inputs', () => {
  const score = scoreCandidate(
    {
      content:
        'Always run `npm run typecheck` and `npm run lint` before merging changes in src/core/memory-promotion.ts.',
      changedFiles: ['src/core/memory-promotion.ts', 'test/memory-promotion.test.mjs'],
      verificationStatus: 'passed',
    },
    ['Run npm run lint before merge.'],
  );

  assert.equal(score.verification, 1);
  assert.ok(score.stability >= 0.6);
  assert.ok(score.reuse >= 0.6);
  assert.ok(score.specificity >= 0.5);
  assert.ok(score.composite >= 0.65);
});

test('scoreCandidate lowers verification and composite for failed candidates', () => {
  const score = scoreCandidate(
    {
      content: 'Might need a workaround in some file.',
      changedFiles: [],
      verificationStatus: 'failed',
    },
    [],
  );

  assert.equal(score.verification, 0);
  assert.ok(score.composite < 0.5);
});

test('dedupe catches obvious duplicates with high overlap', () => {
  const candidate = 'Run npm run test and npm run lint before opening a PR.';
  const existing = ['Run npm run test and npm run lint before opening a PR.'];

  const result = dedupeAgainstExisting(candidate, existing);
  assert.equal(result.isDuplicate, true);
  assert.ok(result.overlapRatio > 0.7);
  assert.equal(result.matchIndex, 0);
});

test('dedupe allows genuinely different content', () => {
  const candidate = 'Use cargo check for fast Rust feedback loops.';
  const existing = ['Store semantic memory in .ddudu/memory/semantic.md.'];

  const result = dedupeAgainstExisting(candidate, existing);
  assert.equal(result.isDuplicate, false);
  assert.ok(result.overlapRatio < 0.5);
});

test('merge combines similar entries and keeps specific candidate detail', () => {
  const candidate = 'Run npm run build then npm run test before release.';
  const existing = 'Run npm run build then npm run test and publish release notes.';

  const merged = mergeWithExisting(candidate, existing);
  assert.match(merged, /before release/);
  assert.match(merged, /publish release notes/);
});

test('promotion decisions match thresholds', () => {
  assert.equal(
    decidePromotion({
      stability: 0.8,
      reuse: 0.7,
      specificity: 0.7,
      verification: 0.9,
      novelty: 0.8,
      composite: 0.75,
    }),
    'promote_semantic',
  );

  assert.equal(
    decidePromotion({
      stability: 0.5,
      reuse: 0.75,
      specificity: 0.6,
      verification: 0.6,
      novelty: 0.7,
      composite: 0.62,
    }),
    'promote_procedural',
  );

  assert.equal(
    decidePromotion({
      stability: 0.45,
      reuse: 0.4,
      specificity: 0.4,
      verification: 0.5,
      novelty: 0.5,
      composite: 0.48,
    }),
    'promote_episodic',
  );

  assert.equal(
    decidePromotion({
      stability: 0.5,
      reuse: 0.6,
      specificity: 0.5,
      verification: 0.2,
      novelty: 0.8,
      composite: 0.58,
    }),
    'keep_working',
  );

  assert.equal(
    decidePromotion({
      stability: 0.2,
      reuse: 0.2,
      specificity: 0.2,
      verification: 0.4,
      novelty: 0.4,
      composite: 0.25,
    }),
    'discard',
  );
});

test('shouldReplace only when candidate is strong and existing entry is old enough', () => {
  assert.equal(
    shouldReplace(
      {
        stability: 0.8,
        reuse: 0.8,
        specificity: 0.7,
        verification: 1,
        novelty: 0.7,
        composite: 0.82,
      },
      10,
    ),
    true,
  );

  assert.equal(
    shouldReplace(
      {
        stability: 0.7,
        reuse: 0.6,
        specificity: 0.6,
        verification: 0.5,
        novelty: 0.5,
        composite: 0.58,
      },
      15,
    ),
    false,
  );

  assert.equal(
    shouldReplace(
      {
        stability: 0.9,
        reuse: 0.9,
        specificity: 0.9,
        verification: 1,
        novelty: 0.9,
        composite: 0.9,
      },
      5,
    ),
    false,
  );
});

test('append writes optional confidence metadata as YAML frontmatter', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ddudu-memory-promotion-'));
  const previousCwd = process.cwd();
  process.chdir(root);

  try {
    const backend = await getMemoryBackend(root);
    await backend.append(
      root,
      'semantic',
      'Prefer explicit score thresholds for promotion.',
      {
        confidence: 0.85,
        sourceRunId: 'abc123',
        promotedAt: '2026-03-11T12:00:00Z',
        score: {
          stability: 0.9,
          reuse: 0.8,
          specificity: 0.7,
          verification: 1,
          novelty: 0.6,
          composite: 0.82,
        },
      },
    );

    const memoryFile = resolve(root, '.ddudu', 'memory', 'semantic.md');
    const content = await readFile(memoryFile, 'utf8');

    assert.match(content, /^## Entry — /m);
    assert.match(content, /^---$/m);
    assert.match(content, /confidence: 0.85/);
    assert.match(content, /sourceRunId: "abc123"/);
    assert.match(content, /promotedAt: "2026-03-11T12:00:00Z"/);
    assert.match(content, /score: \{ stability: 0.9, reuse: 0.8, specificity: 0.7, verification: 1, novelty: 0.6, composite: 0.82 \}/);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
