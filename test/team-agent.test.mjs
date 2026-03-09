import test from 'node:test';
import assert from 'node:assert/strict';

import { TeamOrchestrator } from '../dist/core/team-agent.js';

test('TeamOrchestrator respects worker dependencies during parallel execution', async () => {
  const events = [];
  let plannerDoneAt = 0;
  let executorStartedAt = 0;

  const orchestrator = new TeamOrchestrator({
    name: 'dependency-aware-team',
    strategy: 'parallel',
    maxRounds: 1,
    agents: [
      {
        id: 'lead',
        name: 'Jennie',
        role: 'lead',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        systemPrompt: 'coordinate',
      },
      {
        id: 'planner',
        name: 'Rosé',
        role: 'worker',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'plan',
        taskLabel: 'Define scope',
        workUnitId: 'unit-planner',
      },
      {
        id: 'executor',
        name: 'Lisa',
        role: 'worker',
        provider: 'openai',
        model: 'gpt-5.4',
        systemPrompt: 'execute',
        taskLabel: 'Implement the change',
        workUnitId: 'unit-executor',
        dependencyUnitIds: ['unit-planner'],
      },
    ],
    runAgent: async (agent) => {
      events.push(`${agent.id}:start`);
      if (agent.id === 'planner') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        plannerDoneAt = Date.now();
      }
      if (agent.id === 'executor') {
        executorStartedAt = Date.now();
      }
      events.push(`${agent.id}:done`);
      return `${agent.id} ok`;
    },
  });

  const result = await orchestrator.run('plan and implement the change');

  assert.equal(result.success, true);
  assert.ok(events.indexOf('planner:start') !== -1);
  assert.ok(events.indexOf('executor:start') !== -1);
  assert.ok(events.indexOf('planner:done') < events.indexOf('executor:start'));
  assert.ok(executorStartedAt >= plannerDoneAt);
});

test('TeamOrchestrator fails fast when worker dependencies cannot be satisfied', async () => {
  const orchestrator = new TeamOrchestrator({
    name: 'blocked-team',
    strategy: 'parallel',
    maxRounds: 1,
    agents: [
      {
        id: 'lead',
        name: 'Jennie',
        role: 'lead',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        systemPrompt: 'coordinate',
      },
      {
        id: 'planner',
        name: 'Rosé',
        role: 'worker',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'plan',
        taskLabel: 'Define scope',
        workUnitId: 'unit-planner',
        dependencyUnitIds: ['unit-executor'],
      },
      {
        id: 'executor',
        name: 'Lisa',
        role: 'worker',
        provider: 'openai',
        model: 'gpt-5.4',
        systemPrompt: 'execute',
        taskLabel: 'Implement the change',
        workUnitId: 'unit-executor',
        dependencyUnitIds: ['unit-planner'],
      },
    ],
    runAgent: async () => 'ok',
  });

  await assert.rejects(
    orchestrator.run('deadlocked team run'),
    /unresolved dependencies/i,
  );
});
