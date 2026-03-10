import test from 'node:test';
import assert from 'node:assert/strict';

import { createTeamExecutionPlanDraft } from '../dist/tui/native/routing-coordinator.js';
import {
  formatTeamAgentLabel,
  TeamExecutionCoordinator,
  teamAgentPurpose,
} from '../dist/tui/native/team-execution-coordinator.js';

test('TeamExecutionCoordinator.createPlan materializes lead and specialist agents from a draft', () => {
  const coordinator = new TeamExecutionCoordinator();
  const draft = createTeamExecutionPlanDraft(
    'Research the docs, inspect the code paths, implement the change, and review the result',
    'delegate',
    ['jennie', 'lisa', 'rosé'],
  );

  assert.ok(draft);
  const plan = coordinator.createPlan({
    draft,
    resolveRuntime: (mode) => ({
      provider: mode === 'lisa' ? 'openai' : 'anthropic',
      model: mode === 'lisa' ? 'gpt-5.4' : 'claude-sonnet-4-6',
    }),
    orchestratorPrompt: 'Split work clearly.',
  });

  assert.ok(plan.agents.length >= 2);
  assert.equal(plan.agents[0]?.role, 'lead');
  assert.match(plan.agents[0]?.systemPrompt ?? '', /orchestrator_contract/);
  assert.ok(plan.agents.some((agent) => agent.role === 'worker'));
});

test('TeamExecutionCoordinator.run delegates execution to TeamOrchestrator', async () => {
  const coordinator = new TeamExecutionCoordinator();
  const result = await coordinator.run({
    name: 'test-team',
    task: 'Solve the task',
    strategy: 'parallel',
    sharedContext: 'cwd=/tmp',
    signal: new AbortController().signal,
    agents: [
      {
        id: 'lead',
        name: 'Lead',
        role: 'lead',
        mode: 'jennie',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'Lead',
      },
      {
        id: 'worker',
        name: 'Worker',
        role: 'worker',
        mode: 'lisa',
        provider: 'openai',
        model: 'gpt-5.4',
        systemPrompt: 'Work',
        taskLabel: 'Implement',
      },
    ],
    runAgent: async (agent) => `${agent.name} finished`,
  });

  assert.equal(result.success, true);
  assert.match(result.output, /finished/);
});

test('team coordinator helper functions describe specialists consistently', () => {
  const label = formatTeamAgentLabel({
    name: 'ROSÉ',
    role: 'reviewer',
    mode: 'rosé',
    roleProfile: 'reviewer',
  });
  assert.match(label, /Reviewer/i);
  assert.equal(teamAgentPurpose({ role: 'worker', roleProfile: 'executor' }), 'execution');
});

test('TeamExecutionCoordinator.formatLiveStatus summarizes running workers for heartbeat updates', () => {
  const coordinator = new TeamExecutionCoordinator();
  const text = coordinator.formatLiveStatus({
    strategy: 'parallel',
    task: 'Research recent API changes and compare the affected modules',
    elapsedMs: 23_000,
    agentActivities: [
      {
        label: 'ROSÉ',
        mode: 'rosé',
        purpose: 'research',
        status: 'running',
        detail: 'Inspecting mode resolution and fallback behavior',
        updatedAt: 23_000,
      },
      {
        label: 'LISA',
        mode: 'lisa',
        purpose: 'research',
        status: 'queued',
        detail: 'waiting for anthropic provider slot',
        updatedAt: 21_000,
      },
    ],
  });

  assert.match(text, /status: running/);
  assert.match(text, /workers: 1 running · 1 queued/);
  assert.match(text, /ROSÉ · research · running/i);
  assert.match(text, /waiting for anthropic provider slot/i);
});
