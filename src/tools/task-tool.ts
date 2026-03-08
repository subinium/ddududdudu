import { randomUUID } from 'node:crypto';

import { DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL } from '../api/anthropic-base-url.js';
import type { DelegationPurpose } from '../core/delegation.js';
import type { NamedMode } from '../core/types.js';
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
    description: 'Delegate work to another ddudu mode or a focused sub-agent with isolated context.',
    parameters: {
      prompt: { type: 'string', description: 'Prompt for the sub-agent.', required: true },
      purpose: {
        type: 'string',
        description: 'Delegation purpose for automatic mode routing.',
        enum: ['general', 'execution', 'planning', 'research', 'review', 'design', 'oracle'],
      },
      mode: {
        type: 'string',
        description: 'Explicit target ddudu mode.',
        enum: ['jennie', 'lisa', 'rosé', 'jisoo'],
      },
      model: { type: 'string', description: 'Model override for the sub-agent.' },
      system_prompt: { type: 'string', description: 'Optional system prompt override for the delegated agent.' },
    },
  },
  async execute(args, ctx) {
    if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) {
      return { output: 'Missing required argument: prompt', isError: true };
    }

    const purpose =
      typeof args.purpose === 'string' &&
      ['general', 'execution', 'planning', 'research', 'review', 'design', 'oracle'].includes(args.purpose)
        ? (args.purpose as DelegationPurpose)
        : undefined;
    const mode =
      typeof args.mode === 'string' &&
      ['jennie', 'lisa', 'rosé', 'jisoo'].includes(args.mode)
        ? (args.mode as NamedMode)
        : undefined;
    const model = typeof args.model === 'string' && args.model.trim().length > 0 ? args.model : undefined;
    const systemPrompt =
      typeof args.system_prompt === 'string' && args.system_prompt.trim().length > 0
        ? args.system_prompt
        : undefined;

    if (ctx.delegation) {
      const result = await ctx.delegation.run(
        {
          prompt: args.prompt,
          purpose,
          preferredMode: mode,
          preferredModel: model,
          systemPrompt,
          parentSessionId: ctx.sessionId,
        },
        {
          onText: (text: string) => {
            ctx.onProgress?.(text);
          },
          signal: ctx.abortSignal,
        },
      );

      return {
        output: result.text,
        metadata: {
          mode: result.mode,
          provider: result.provider,
          model: result.model,
          purpose: result.purpose,
          localSessionId: result.localSessionId,
          remoteSessionId: result.remoteSessionId,
          usage: result.usage,
          durationMs: result.durationMs,
        },
      };
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
