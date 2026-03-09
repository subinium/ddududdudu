import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL } from '../api/anthropic-base-url.js';
import type { NamedMode } from '../core/types.js';
import type { WorkflowArtifactKind } from '../core/workflow-state.js';
import { HARNESS_MODES } from '../tui/shared/theme.js';
import type { Tool } from './index.js';

const DEFAULT_ORACLE_MODEL = 'claude-opus-4-5';
const DELIVERABLE_KINDS: WorkflowArtifactKind[] = ['answer', 'plan', 'review', 'design', 'patch', 'briefing', 'research'];

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

const buildFileContext = async (cwd: string, files: string[]): Promise<string> => {
  const chunks: string[] = [];

  for (const file of files) {
    const resolvedPath = resolve(cwd, file);
    try {
      const content = await readFile(resolvedPath, 'utf8');
      chunks.push(`--- FILE: ${file} ---\n${content}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      chunks.push(`--- FILE: ${file} ---\n[read error] ${message}`);
    }
  }

  return chunks.join('\n\n');
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

const oracleActivityLabel = (mode?: NamedMode): string =>
  mode ? `${HARNESS_MODES[mode]?.label ?? mode} · oracle` : 'Oracle';

const buildDeliverableQuestion = (
  question: string,
  deliverable?: WorkflowArtifactKind,
  successCriteria?: string[],
): string => {
  if (!deliverable && (!successCriteria || successCriteria.length === 0)) {
    return question;
  }

  const sections = [question.trim()];
  if (deliverable) {
    sections.push(
      '',
      `Requested deliverable: ${deliverable}`,
      `Respond as a concise ${deliverable} deliverable with clear structure.`,
    );
  }
  if (successCriteria && successCriteria.length > 0) {
    sections.push('', 'Success criteria:', ...successCriteria.map((criterion) => `- ${criterion}`));
  }

  return sections.join('\n');
};

export const oracleTool: Tool = {
  definition: {
    name: 'oracle',
    description: 'Route a question to a stronger delegated mode with optional file context.',
    parameters: {
      question: { type: 'string', description: 'Question to ask the oracle.', required: true },
      mode: {
        type: 'string',
        description: 'Optional explicit mode override for the oracle.',
        enum: ['jennie', 'lisa', 'rosé', 'jisoo'],
      },
      model: { type: 'string', description: 'Optional model override.' },
      files: {
        type: 'array',
        description: 'Optional file paths to include as context.',
        items: { type: 'string', description: 'Relative file path.' },
      },
      deliverable: {
        type: 'string',
        description: 'Requested deliverable kind for the oracle response.',
        enum: DELIVERABLE_KINDS,
      },
      success_criteria: {
        type: 'array',
        description: 'Optional success criteria for the oracle response.',
        items: { type: 'string', description: 'A concrete success criterion.' },
      },
    },
  },
  async execute(args, ctx) {
    if (typeof args.question !== 'string' || args.question.trim().length === 0) {
      return { output: 'Missing required argument: question', isError: true };
    }

    const token = ctx.authToken || resolveToken();
    if (!token) {
      return {
        output: 'No API token found. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.',
        isError: true,
      };
    }

    const files = Array.isArray(args.files)
      ? args.files.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const fileContext = files.length > 0 ? await buildFileContext(ctx.cwd, files) : '';

    const question = fileContext
      ? `Question:\n${args.question}\n\nContext files:\n${fileContext}`
      : args.question;

    const preferredMode =
      typeof args.mode === 'string' &&
      ['jennie', 'lisa', 'rosé', 'jisoo'].includes(args.mode)
        ? (args.mode as NamedMode)
        : undefined;
    const preferredModel =
      typeof args.model === 'string' && args.model.trim().length > 0 ? args.model : undefined;
    const deliverable =
      typeof args.deliverable === 'string' && DELIVERABLE_KINDS.includes(args.deliverable as WorkflowArtifactKind)
        ? (args.deliverable as WorkflowArtifactKind)
        : undefined;
    const successCriteria = Array.isArray(args.success_criteria)
      ? args.success_criteria.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const delegatedQuestion = buildDeliverableQuestion(question, deliverable, successCriteria);

    if (ctx.delegation) {
      const activityId = randomUUID();
      ctx.onAgentActivity?.({
        id: activityId,
        label: oracleActivityLabel(preferredMode),
        status: 'running',
        mode: preferredMode,
        purpose: 'oracle',
        detail: preview(args.question),
      });

      try {
        const contextSnapshot = ctx.contextSnapshot
          ? await ctx.contextSnapshot(question, 'oracle')
          : undefined;
        const artifacts = ctx.artifacts?.('oracle', 4);
        const result = await ctx.delegation.run(
          {
            prompt: delegatedQuestion,
            purpose: 'oracle',
            requestedArtifactKind: deliverable,
            successCriteria,
            preferredMode,
            preferredModel,
            parentSessionId: ctx.sessionId,
            cwd: ctx.cwd,
            isolatedLabel: `oracle-${preferredMode ?? 'auto'}`,
            verificationMode: 'none',
            contextSnapshot,
            artifacts,
          },
          {
            onText: (text: string) => {
              ctx.onProgress?.(text);
              if (text.trim()) {
                ctx.onAgentActivity?.({
                  id: activityId,
                  label: oracleActivityLabel(preferredMode),
                  status: 'running',
                  mode: preferredMode,
                  purpose: 'oracle',
                  detail: preview(text, 64),
                });
              }
            },
            signal: ctx.abortSignal,
          },
        );

        ctx.onAgentActivity?.({
          id: activityId,
          label: oracleActivityLabel(result.mode),
          status: 'done',
          mode: result.mode,
          purpose: result.purpose,
          detail: preview(result.text, 64),
          workspacePath: result.workspace?.path,
        });

        return {
          output: result.text,
          metadata: {
            mode: result.mode,
            provider: result.provider,
            model: result.model,
            files,
            usage: result.usage,
            localSessionId: result.localSessionId,
            remoteSessionId: result.remoteSessionId,
            durationMs: result.durationMs,
            deliverable,
            successCriteria,
          },
        };
      } catch (error: unknown) {
        ctx.onAgentActivity?.({
          id: activityId,
          label: oracleActivityLabel(preferredMode),
          status: 'error',
          mode: preferredMode,
          purpose: 'oracle',
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    const { AnthropicClient } = await import('../api/anthropic-client.js');
    const client = new AnthropicClient({
      token,
      baseUrl: ctx.authBaseUrl || resolveBaseUrl(),
      model: process.env.DDUDU_ORACLE_MODEL ?? DEFAULT_ORACLE_MODEL,
      maxTokens: 8192,
    });

    let output = '';
    let usage = { input: 0, output: 0 };

    try {
      await client.stream(
        'You are an expert oracle model. Answer clearly with strong technical judgment.',
        [{ role: 'user', content: delegatedQuestion }],
        {
          onText: (text: string) => {
            output += text;
            ctx.onProgress?.(text);
          },
          onError: () => {},
          onDone: (_text: string, finalUsage: { input: number; output: number }) => {
            usage = finalUsage;
          },
        },
        ctx.abortSignal,
      );

      return {
        output,
        metadata: {
          usage,
          model: process.env.DDUDU_ORACLE_MODEL ?? DEFAULT_ORACLE_MODEL,
          files,
          deliverable,
          successCriteria,
        },
      };
    } catch (err: unknown) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
        metadata: {
          usage,
          model: process.env.DDUDU_ORACLE_MODEL ?? DEFAULT_ORACLE_MODEL,
          files,
          deliverable,
          successCriteria,
        },
      };
    }
  },
};
