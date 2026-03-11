import test from 'node:test';
import assert from 'node:assert/strict';

import { TokenCounter } from '../dist/core/token-counter.js';

test('setBudget keeps isOverBudget false when estimated cost is under limit', () => {
  const counter = new TokenCounter('gpt-4.1');
  counter.setBudget(0.01);
  counter.addUsage(1_000, 0);

  assert.equal(counter.isOverBudget(), false);
});

test('isOverBudget returns true when estimated cost exceeds budget limit', () => {
  const counter = new TokenCounter('gpt-4.1');
  counter.setBudget(0.01);
  counter.addUsage(0, 2_000);

  assert.equal(counter.isOverBudget(), true);
});

test('shouldWarnBudget returns true at default 80 percent threshold', () => {
  const counter = new TokenCounter('gpt-4.1');
  counter.setBudget(0.01);
  counter.addUsage(4_000, 0);

  assert.equal(counter.shouldWarnBudget(), true);
});

test('clearBudget resets budget tracking to unlimited mode', () => {
  const counter = new TokenCounter('gpt-4.1');
  counter.setBudget(0.01);
  counter.addUsage(0, 2_000);
  assert.equal(counter.isOverBudget(), true);

  counter.clearBudget();

  assert.equal(counter.isOverBudget(), false);
  assert.equal(counter.getRemainingBudgetUsd(), null);
});

test('no-budget mode is permissive by default', () => {
  const counter = new TokenCounter('gpt-4.1');
  counter.addUsage(100_000, 100_000);

  assert.equal(counter.isOverBudget(), false);
  assert.equal(counter.shouldWarnBudget(), false);
});

test('getEstimatedCostUsd calculates model cost with per-1k pricing', () => {
  const counter = new TokenCounter('claude-opus-4-20250514');
  counter.addUsage(2_000, 1_000);

  assert.equal(counter.getEstimatedCostUsd(), 0.105);
});

test('onBudgetEvent triggers callback when warning threshold is crossed', () => {
  const counter = new TokenCounter('gpt-4.1');
  const events = [];

  counter.onBudgetEvent((event) => {
    events.push(event);
  });
  counter.setBudget(0.01);
  counter.addUsage(3_000, 0);
  counter.addUsage(1_000, 0);

  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'warning');
  assert.equal(events[0].currentCostUsd, 0.008);
  assert.equal(events[0].budgetMaxUsd, 0.01);
  assert.equal(events[0].percentUsed, 0.8);
});
