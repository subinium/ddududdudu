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

const preview = (value: string, maxLength: number = 80): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
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
      const activityId = randomUUID();
      ctx.onAgentActivity?.({
        id: activityId,
        label: 'task',
        status: 'running',
        mode,
        purpose,
        detail: preview(args.prompt),
      });

      try {
        const contextSnapshot = ctx.contextSnapshot
          ? await ctx.contextSnapshot(args.prompt, purpose)
          : undefined;
        const artifacts = ctx.artifacts?.(purpose ?? 'general', 4);
        const result = await ctx.delegation.run(
          {
            prompt: args.prompt,
            purpose,
            preferredMode: mode,
            preferredModel: model,
            systemPrompt,
            parentSessionId: ctx.sessionId,
            cwd: ctx.cwd,
            isolatedLabel: `task-${purpose ?? mode ?? 'general'}`,
            contextSnapshot,
            artifacts,
          },
          {
            onText: (text: string) => {
              ctx.onProgress?.(text);
              if (text.trim()) {
                ctx.onAgentActivity?.({
                  id: activityId,
                  label: 'task',
                  status: 'running',
                  mode,
                  purpose,
                  detail: preview(text, 64),
                });
              }
            },
            onVerificationState: (state) => {
              ctx.onAgentActivity?.({
                id: activityId,
                label: 'task',
                status:
                  state.status === 'running'
                    ? 'verifying'
                    : state.status === 'passed' || state.status === 'skipped'
                      ? 'done'
                      : 'error',
                mode,
                purpose,
                detail: state.summary,
              });
          },
            signal: ctx.abortSignal,
          },
        );

        ctx.onAgentActivity?.({
          id: activityId,
          label: 'task',
          status: 'done',
          mode: result.mode,
          purpose: result.purpose,
          detail:
            result.verification?.summary ??
            result.workspace?.path ??
            preview(result.text, 64),
          workspacePath: result.workspace?.path,
        });

        const verificationNote =
          result.verification && result.verification.status !== 'skipped'
            ? `\n\n## Verification\n${result.verification.summary}`
            : '';

        return {
          output: `${result.text}${verificationNote}`.trim(),
          metadata: {
            mode: result.mode,
            provider: result.provider,
            model: result.model,
            purpose: result.purpose,
            localSessionId: result.localSessionId,
            remoteSessionId: result.remoteSessionId,
            cwd: result.cwd,
            workspacePath: result.workspace?.path,
            verification: result.verification,
            usage: result.usage,
            durationMs: result.durationMs,
          },
        };
      } catch (error: unknown) {
        ctx.onAgentActivity?.({
          id: activityId,
          label: 'task',
          status: 'error',
          mode,
          purpose,
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
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
