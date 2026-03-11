import test from 'node:test';
import assert from 'node:assert/strict';

import { planWorkAllocation } from '../dist/core/work-allocation.js';

test('planWorkAllocation keeps simple implementation runs scout-heavy without a default reviewer', () => {
  const allocation = planWorkAllocation(
    'Implement the runtime fix with a minimal diff',
    'parallel',
    ['jennie', 'lisa', 'rosé'],
  );

  const roles = allocation.units.map((unit) => unit.role);
  assert.ok(roles.includes('explorer'));
  assert.ok(roles.includes('executor'));
  assert.ok(!roles.includes('reviewer'));
});

test('planWorkAllocation avoids planner for focused implementation work with local docs context', () => {
  const allocation = planWorkAllocation(
    'Implement the runtime fallback fix using the repo docs as guidance',
    'parallel',
    ['jennie', 'lisa', 'rosé'],
  );

  const roles = allocation.units.map((unit) => unit.role);
  assert.ok(roles.includes('librarian'));
  assert.ok(roles.includes('executor'));
  assert.ok(!roles.includes('planner'));
});

test('planWorkAllocation does not make planner a full barrier for discovery workers', () => {
  const allocation = planWorkAllocation(
    'Plan the repo-wide fix, inspect the codebase, and implement the change',
    'parallel',
    ['jennie', 'lisa', 'rosé'],
  );

  const planner = allocation.units.find((unit) => unit.role === 'planner');
  const explorer = allocation.units.find((unit) => unit.role === 'explorer');
  const executor = allocation.units.find((unit) => unit.role === 'executor');

  assert.ok(planner);
  assert.ok(explorer);
  assert.ok(executor);
  assert.ok(!explorer.dependsOn.includes(planner.label));
  assert.ok(executor.dependsOn.includes(planner.label));
});
