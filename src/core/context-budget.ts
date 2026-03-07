export type TaskType =
  | 'implementation'
  | 'bug_fix'
  | 'review'
  | 'architecture'
  | 'general';

export interface ContextBudget {
  system: number;
  history: number;
  files: number;
  tools: number;
}

const TASK_KEYWORDS: { [key in Exclude<TaskType, 'general'>]: string[] } = {
  implementation: ['implement', 'create', 'add', 'build'],
  bug_fix: ['fix', 'bug', 'error', 'broken', 'crash'],
  review: ['review', 'check', 'audit', 'look at'],
  architecture: ['design', 'architecture', 'plan', 'structure'],
};

const BUDGET_RATIOS: { [key in TaskType]: ContextBudget } = {
  implementation: { system: 0.4, history: 0.3, files: 0.2, tools: 0.1 },
  bug_fix: { system: 0.2, history: 0.5, files: 0.2, tools: 0.1 },
  review: { system: 0.3, history: 0.2, files: 0.4, tools: 0.1 },
  architecture: { system: 0.5, history: 0.3, files: 0.1, tools: 0.1 },
  general: { system: 0.3, history: 0.4, files: 0.2, tools: 0.1 },
};

export class ContextBudgetManager {
  public detectTaskType(message: string): TaskType {
    const normalized = message.toLowerCase();

    for (const [taskType, keywords] of Object.entries(TASK_KEYWORDS)) {
      if (keywords.some((keyword: string) => normalized.includes(keyword))) {
        return taskType as TaskType;
      }
    }

    return 'general';
  }

  public allocateBudget(taskType: TaskType, contextLimit: number): ContextBudget {
    const limit = Math.max(0, Math.floor(contextLimit));
    const ratio = BUDGET_RATIOS[taskType] ?? BUDGET_RATIOS.general;

    const system = Math.floor(limit * ratio.system);
    const history = Math.floor(limit * ratio.history);
    const files = Math.floor(limit * ratio.files);
    const tools = Math.max(limit - system - history - files, 0);

    return { system, history, files, tools };
  }
}
