import test from 'node:test';
import assert from 'node:assert/strict';

import { ResultAugmenter } from '../dist/core/result-augmentation.js';

const ok = (output = 'done') => ({ output, isError: false });
const err = (output = 'failed') => ({ output, isError: true });
const baseCtx = () => ({
  recentToolNames: [],
  contextUsagePercent: 30,
  pendingVerification: false,
  availableSkills: [],
  currentMode: 'JENNIE',
});

test('ResultAugmenter: no nudge on error results', () => {
  const aug = new ResultAugmenter();
  const result = aug.augment('write_file', {}, err(), baseCtx());
  assert.equal(result.output, 'failed');
  assert.equal(result.isError, true);
});

test('ResultAugmenter: verify-after-edit fires on file mutation', () => {
  const aug = new ResultAugmenter();
  const result = aug.augment('write_file', {}, ok(), baseCtx());
  assert.ok(result.output.includes('[Nudge]'));
  assert.ok(result.output.includes('lint_runner'));
});

test('ResultAugmenter: verify-after-edit respects cooldown', () => {
  const aug = new ResultAugmenter();
  // First call triggers
  const r1 = aug.augment('edit_file', {}, ok(), baseCtx());
  assert.ok(r1.output.includes('[Nudge]'));

  // Calls within cooldown (4) should NOT trigger
  const r2 = aug.augment('edit_file', {}, ok(), baseCtx());
  assert.ok(!r2.output.includes('lint_runner'));
  const r3 = aug.augment('edit_file', {}, ok(), baseCtx());
  assert.ok(!r3.output.includes('lint_runner'));
  const r4 = aug.augment('edit_file', {}, ok(), baseCtx());
  assert.ok(!r4.output.includes('lint_runner'));

  // 5th call (callCount=4, lastFired=0, 4-0 >= 4) should trigger again
  const r5 = aug.augment('edit_file', {}, ok(), baseCtx());
  assert.ok(r5.output.includes('lint_runner'));
});

test('ResultAugmenter: context-pressure fires at 75%+', () => {
  const aug = new ResultAugmenter();
  const ctx = { ...baseCtx(), contextUsagePercent: 80 };
  const result = aug.augment('read_file', {}, ok(), ctx);
  assert.ok(result.output.includes('Context usage at 80%'));
  assert.ok(result.output.includes('/compact'));
});

test('ResultAugmenter: context-pressure does NOT fire below 75%', () => {
  const aug = new ResultAugmenter();
  const ctx = { ...baseCtx(), contextUsagePercent: 50 };
  const result = aug.augment('read_file', {}, ok(), ctx);
  assert.ok(!result.output.includes('Context usage'));
});

test('ResultAugmenter: search-broadening fires after 3+ sequential searches', () => {
  const aug = new ResultAugmenter();
  const ctx = {
    ...baseCtx(),
    recentToolNames: ['grep', 'glob', 'codebase_search', 'grep'],
  };
  const result = aug.augment('grep', {}, ok(), ctx);
  assert.ok(result.output.includes('sequential searches'));
  assert.ok(result.output.includes('task'));
});

test('ResultAugmenter: search-broadening does NOT fire with few searches', () => {
  const aug = new ResultAugmenter();
  const ctx = {
    ...baseCtx(),
    recentToolNames: ['grep', 'read_file'],
  };
  const result = aug.augment('grep', {}, ok(), ctx);
  assert.ok(!result.output.includes('sequential searches'));
});

test('ResultAugmenter: skill-awareness fires on task delegation', () => {
  const aug = new ResultAugmenter();
  const ctx = { ...baseCtx(), availableSkills: ['ts-react', 'tdd', 'scaffold'] };
  const result = aug.augment('task', {}, ok(), ctx);
  assert.ok(result.output.includes('Available skills'));
  assert.ok(result.output.includes('ts-react'));
});

test('ResultAugmenter: skill-awareness does NOT fire without skills', () => {
  const aug = new ResultAugmenter();
  const ctx = { ...baseCtx(), availableSkills: [] };
  const result = aug.augment('task', {}, ok(), ctx);
  assert.ok(!result.output.includes('Available skills'));
});

test('ResultAugmenter: verify-pending fires on read when edits unverified', () => {
  const aug = new ResultAugmenter();
  const ctx = { ...baseCtx(), pendingVerification: true };
  const result = aug.augment('read_file', {}, ok(), ctx);
  assert.ok(result.output.includes('Unverified edits'));
});

test('ResultAugmenter: verify-pending does NOT fire without pending edits', () => {
  const aug = new ResultAugmenter();
  const ctx = { ...baseCtx(), pendingVerification: false };
  const result = aug.augment('read_file', {}, ok(), ctx);
  assert.ok(!result.output.includes('Unverified edits'));
});

test('ResultAugmenter: reset clears cooldowns', () => {
  const aug = new ResultAugmenter();
  // Fire verify-after-edit
  aug.augment('write_file', {}, ok(), baseCtx());
  // Should be in cooldown
  const r1 = aug.augment('write_file', {}, ok(), baseCtx());
  assert.ok(!r1.output.includes('lint_runner'));

  // Reset
  aug.reset();

  // Should fire again immediately
  const r2 = aug.augment('write_file', {}, ok(), baseCtx());
  assert.ok(r2.output.includes('lint_runner'));
});

test('ResultAugmenter: multiple nudges can fire simultaneously', () => {
  const aug = new ResultAugmenter();
  // File mutation + high context + pending verification
  const ctx = {
    ...baseCtx(),
    contextUsagePercent: 85,
    pendingVerification: true,
  };
  const result = aug.augment('write_file', {}, ok(), ctx);
  // Should contain both verify-after-edit and context-pressure nudges
  assert.ok(result.output.includes('lint_runner'));
  assert.ok(result.output.includes('Context usage'));
});

test('ResultAugmenter: original output is preserved', () => {
  const aug = new ResultAugmenter();
  const result = aug.augment('write_file', {}, ok('File written successfully'), baseCtx());
  assert.ok(result.output.startsWith('File written successfully'));
  assert.ok(result.output.includes('[Nudge]'));
});

test('ResultAugmenter: passthrough when no rules match', () => {
  const aug = new ResultAugmenter();
  const result = aug.augment('bash', {}, ok('command output'), baseCtx());
  assert.equal(result.output, 'command output');
  assert.equal(result.isError, false);
});
