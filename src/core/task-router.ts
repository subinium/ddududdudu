import { randomUUID } from 'node:crypto';
import type { AgentRole, TaskSpec } from './sub-agent.js';

export type RoutingStrategy = 'direct' | 'parallel' | 'sequential' | 'oracle';

export interface RoutingPlan {
  strategy: RoutingStrategy;
  tasks: TaskSpec[];
}

export interface RouterConfig {
  models: string[];
  oracleModel?: string;
}

const ORACLE_TRIGGERS = [
  /\boracle\b/i,
  /\bsecond opinion\b/i,
  /\bstronger model\b/i,
  /\bthink harder\b/i,
  /\bdeep think\b/i,
];

const REVIEW_TRIGGERS = [
  /\breview\b/i,
  /\baudit\b/i,
  /\bcheck\b.*\bcode\b/i,
  /\banalyze\b/i,
];

const MULTI_TASK_PATTERNS = [
  /^\s*\d+[\.\)]\s/m,
  /\bfirst\b.*\bthen\b/i,
  /\band also\b/i,
  /\badditionally\b/i,
];

const matchesAny = (text: string, patterns: RegExp[]): boolean => {
  return patterns.some((p) => p.test(text));
};

const extractNumberedTasks = (prompt: string): string[] => {
  const lines = prompt.split('\n');
  const numbered: string[] = [];
  let current = '';

  for (const line of lines) {
    const match = /^\s*\d+[\.\)]\s+(.*)/.exec(line);
    if (match) {
      if (current) numbered.push(current.trim());
      current = match[1] ?? '';
    } else if (current && line.trim()) {
      current += ' ' + line.trim();
    }
  }

  if (current) numbered.push(current.trim());
  return numbered.length >= 2 ? numbered : [];
};

const selectRole = (prompt: string): AgentRole => {
  if (matchesAny(prompt, REVIEW_TRIGGERS)) return 'reviewer';
  if (/\bresearch\b|\bfind\b|\bsearch\b/i.test(prompt)) return 'researcher';
  if (/\bimplement\b|\bcreate\b|\bbuild\b|\bwrite\b.*\bcode\b/i.test(prompt)) return 'coder';
  return 'general';
};

export const routePrompt = (prompt: string, config: RouterConfig): RoutingPlan => {
  if (matchesAny(prompt, ORACLE_TRIGGERS) && config.oracleModel) {
    return {
      strategy: 'oracle',
      tasks: [{
        id: randomUUID(),
        prompt,
        role: 'oracle',
        model: config.oracleModel,
      }],
    };
  }

  const numberedTasks = extractNumberedTasks(prompt);
  if (numberedTasks.length >= 2) {
    return {
      strategy: 'parallel',
      tasks: numberedTasks.map((taskPrompt, i) => ({
        id: `task-${i}`,
        prompt: taskPrompt,
        role: selectRole(taskPrompt),
        model: config.models[0],
      })),
    };
  }

  if (matchesAny(prompt, MULTI_TASK_PATTERNS)) {
    return {
      strategy: 'sequential',
      tasks: [{
        id: randomUUID(),
        prompt,
        role: selectRole(prompt),
        model: config.models[0],
      }],
    };
  }

  return {
    strategy: 'direct',
    tasks: [{
      id: randomUUID(),
      prompt,
      role: selectRole(prompt),
      model: config.models[0],
    }],
  };
};
