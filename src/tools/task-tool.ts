import { randomUUID } from 'node:crypto';

import { DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL } from '../api/anthropic-base-url.js';
import { SubAgentPool } from '../core/sub-agent.js';
import type { Tool } from './index.js';

const resolveToken = (): string => {
  return process.env.ANTHROPIC_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '';
};

const resolveBaseUrl = (): string => {
  if (process.env.ANTHROPIC_BASE_URL) {
    return process.env.ANTHROPIC_BASE_URL;
  }

  if (process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    return DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL;
  }

  return DEFAULT_ANTHROPIC_BASE_URL;
};

export const taskTool: Tool = {
  definition: {
    name: 'task',
    description: 'Spawn a sub-agent for delegated completion.',
    parameters: {
      prompt: { type: 'string', description: 'Prompt for the sub-agent.', required: true },
      model: { type: 'string', description: 'Model override for the sub-agent.' },
    },
  },
  async execute(args, ctx) {
    if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
      return { output: 'Missing required argument: prompt', isError: true };
    }

    const token = ctx.authToken || resolveToken();
    if (!token) {
      return {
        output: 'No API token found. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.',
        isError: true,
      };
    }

    const pool = new SubAgentPool({
      token,
      baseUrl: ctx.authBaseUrl || resolveBaseUrl(),
      defaultModel: 'claude-sonnet-4-6',
      defaultSystemPrompt: 'You are a focused sub-agent. Complete the task precisely.',
    });

    const taskId = randomUUID();
    const model = typeof args.model === 'string' && args.model.trim().length > 0 ? args.model : undefined;

    const result = await pool.runTask(
      {
        id: taskId,
        prompt: args.prompt,
        role: 'general',
        model,
      },
      (text) => {
        ctx.onProgress?.(text);
      },
      ctx.abortSignal,
    );

    if (result.status !== 'completed') {
      return {
        output: result.error ?? `Sub-agent failed with status: ${result.status}`,
        isError: true,
        metadata: {
          taskId,
          status: result.status,
          usage: result.usage,
          durationMs: result.durationMs,
        },
      };
    }

    return {
      output: result.text,
      metadata: {
        taskId,
        status: result.status,
        usage: result.usage,
        durationMs: result.durationMs,
      },
    };
  },
};
