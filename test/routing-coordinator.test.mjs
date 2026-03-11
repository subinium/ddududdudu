import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyJennieAutoRoute,
  createTeamExecutionPlanDraft,
  formatAutoRouteNotice,
  shouldRunPlanningInterview,
} from '../dist/tui/native/routing-coordinator.js';

test('classifyJennieAutoRoute prefers delegate routing for mixed planning and execution work', () => {
  const decision = classifyJennieAutoRoute(
    'Plan the refactor, inspect the codebase, and implement the runtime fallback fix across the repo',
    ['jennie', 'lisa', 'rosé', 'jisoo'],
  );

  assert.equal(decision.kind, 'delegate');
  assert.equal(decision.purpose, 'planning');
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
    shouldRunPlanningInterview('Break this across the repo, inspect the codebase, research the constraints, implement the runtime fix, and review the result before landing it', {
      kind: 'team',
      reason: 'multi-domain request',
      strategy: 'delegate',
    }),
    true,
  );

  assert.equal(
    shouldRunPlanningInterview('Implement the runtime fallback fix across the repo with the smallest safe diff', {
      kind: 'delegate',
      reason: 'execution should start from the smallest executable unit',
      purpose: 'execution',
      preferredMode: 'lisa',
    }),
    false,
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
  assert.equal(decision.executionClass, 'research_fast');
  assert.equal(shouldRunPlanningInterview('omo/omc/omx를 리서치해줘', decision), false);

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
