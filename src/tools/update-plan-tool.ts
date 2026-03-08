import { randomUUID } from 'node:crypto';

import type { PlanItem, PlanItemStatus } from '../core/workflow-state.js';
import type { Tool } from './index.js';

const isPlanStatus = (value: unknown): value is PlanItemStatus => {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
};

const formatItems = (items: PlanItem[]): string => {
  if (items.length === 0) {
    return 'Plan is empty.';
  }

  return items
    .map((item, index) => `${index + 1}. [${item.status}] ${item.step}${item.owner ? ` · ${item.owner}` : ''}`)
    .join('\n');
};

export const updatePlanTool: Tool = {
  definition: {
    name: 'update_plan',
    description: 'Create, replace, or update the current execution plan / todo list.',
    parameters: {
      action: {
        type: 'string',
        description: 'Plan action to perform.',
        required: true,
        enum: ['list', 'add', 'update', 'replace', 'clear'],
      },
      step: { type: 'string', description: 'Plan step text or identifier for add/update.' },
      status: {
        type: 'string',
        description: 'Plan step status.',
        enum: ['pending', 'in_progress', 'completed'],
      },
      owner: { type: 'string', description: 'Optional owner or mode label for the step.' },
      items: {
        type: 'array',
        description: 'Full replacement list for the plan.',
        items: {
          type: 'object',
          description: 'Plan item.',
          properties: {
            id: { type: 'string', description: 'Optional stable ID.' },
            step: { type: 'string', description: 'Plan step text.' },
            status: {
              type: 'string',
              description: 'Plan status.',
              enum: ['pending', 'in_progress', 'completed'],
            },
            owner: { type: 'string', description: 'Optional owner or mode label.' },
          },
        },
      },
    },
  },
  async execute(args, ctx) {
    if (!ctx.plan) {
      return { output: 'Plan manager is not available in this context.', isError: true };
    }

    const action = typeof args.action === 'string' ? args.action : '';
    if (!['list', 'add', 'update', 'replace', 'clear'].includes(action)) {
      return { output: 'Invalid action for update_plan.', isError: true };
    }

    if (action === 'list') {
      return { output: formatItems(ctx.plan.list()) };
    }

    if (action === 'clear') {
      await ctx.plan.clear();
      return { output: 'Plan cleared.' };
    }

    if (action === 'replace') {
      if (!Array.isArray(args.items)) {
        return { output: 'replace requires items[]', isError: true };
      }

      const items: PlanItem[] = args.items
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({
          id: typeof item.id === 'string' && item.id.trim() ? item.id : randomUUID(),
          step: typeof item.step === 'string' ? item.step.trim() : '',
          status: isPlanStatus(item.status) ? item.status : 'pending',
          owner: typeof item.owner === 'string' && item.owner.trim() ? item.owner.trim() : undefined,
          updatedAt: new Date().toISOString(),
        }))
        .filter((item) => item.step.length > 0);

      await ctx.plan.replace(items);
      return { output: formatItems(ctx.plan.list()) };
    }

    if (typeof args.step !== 'string' || args.step.trim().length === 0) {
      return { output: `${action} requires step`, isError: true };
    }

    const status = isPlanStatus(args.status) ? args.status : undefined;
    const owner = typeof args.owner === 'string' && args.owner.trim() ? args.owner.trim() : undefined;

    if (action === 'add') {
      await ctx.plan.add(args.step.trim(), status ?? 'pending', owner);
      return { output: formatItems(ctx.plan.list()) };
    }

    await ctx.plan.update(args.step.trim(), {
      status,
      owner,
    });
    return { output: formatItems(ctx.plan.list()) };
  },
};
