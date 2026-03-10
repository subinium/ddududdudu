import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyJennieAutoRoute,
  createTeamExecutionPlanDraft,
  formatAutoRouteNotice,
  shouldRunPlanningInterview,
} from '../dist/tui/native/routing-coordinator.js';

test('classifyJennieAutoRoute returns team routing for mixed planning and execution work', () => {
  const decision = classifyJennieAutoRoute(
    'Plan the refactor, inspect the codebase, and implement the runtime fallback fix across the repo',
    ['jennie', 'lisa', 'rosé', 'jisoo'],
  );

  assert.equal(decision.kind, 'team');
  assert.ok(decision.strategy === 'parallel' || decision.strategy === 'delegate');
});

test('formatAutoRouteNotice renders delegate and team summaries', () => {
  assert.equal(
    formatAutoRouteNotice({
      kind: 'delegate',
      reason: 'review request',
      purpose: 'review',
      preferredMode: 'rosé',
    }),
    'Auto route · ROSÉ · review · review request',
  );

  assert.equal(
    formatAutoRouteNotice({
      kind: 'team',
      reason: 'multi-domain request',
      strategy: 'parallel',
    }),
    'Auto route · team parallel · multi-domain request',
  );
});

test('shouldRunPlanningInterview stays off for small direct work and on for ambiguous team work', () => {
  assert.equal(
    shouldRunPlanningInterview('fix typo', {
      kind: 'direct',
      reason: 'short direct prompt',
    }),
    false,
  );

  assert.equal(
    shouldRunPlanningInterview('Refactor the runtime and make it production ready', {
      kind: 'team',
      reason: 'multi-domain request',
      strategy: 'delegate',
    }),
    true,
  );
});

test('createTeamExecutionPlanDraft returns allocation and preferred lead mode', () => {
  const draft = createTeamExecutionPlanDraft(
    'Research the repo rules, inspect code paths, implement the fix, and review risks',
    'delegate',
    ['jennie', 'lisa', 'rosé'],
  );

  assert.ok(draft);
  assert.ok(draft.allocation.units.length >= 3);
  assert.ok(['jennie', 'lisa', 'rosé'].includes(draft.leadMode));
});

test('itemized research routes to a parallel team with one worker per subject', () => {
  const decision = classifyJennieAutoRoute(
    'omo/omc/omx를 리서치해줘',
    ['jennie', 'lisa', 'rosé'],
  );

  assert.equal(decision.kind, 'team');
  assert.equal(decision.strategy, 'parallel');

  const draft = createTeamExecutionPlanDraft(
    'omo/omc/omx를 리서치해줘',
    'parallel',
    ['jennie', 'lisa', 'rosé'],
  );

  assert.ok(draft);
  assert.equal(draft.allocation.units.length, 3);
  assert.ok(draft.allocation.units.every((unit) => unit.role === 'explorer'));
  assert.ok(draft.allocation.units.every((unit) => unit.readOnly === true));
});
