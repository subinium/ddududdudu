import { randomUUID } from 'node:crypto';

import { DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_OPENROUTER_ANTHROPIC_BASE_URL } from '../api/anthropic-base-url.js';
import type { DelegationPurpose } from '../core/delegation.js';
import type { NamedMode } from '../core/types.js';
import {
  buildSpecialistPrompt,
  formatSpecialistLabel,
  getSpecialistRoleProfile,
  resolveModeForSpecialistRole,
  type SpecialistRole,
} from '../core/specialist-roles.js';
import { HARNESS_MODES } from '../tui/shared/theme.js';
import type { WorkflowArtifactKind } from '../core/workflow-state.js';
import type { Tool } from './index.js';

const DELIVERABLE_KINDS: WorkflowArtifactKind[] = ['answer', 'plan', 'review', 'design', 'patch', 'briefing', 'research'];
const SPECIALIST_ROLES: SpecialistRole[] = ['planner', 'explorer', 'librarian', 'executor', 'designer', 'reviewer', 'oracle'];

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

const activityLabel = (mode?: NamedMode, purpose?: DelegationPurpose, specialistRole?: SpecialistRole): string => {
  if (specialistRole) {
    return formatSpecialistLabel(specialistRole, mode);
  }

  const purposeRole = (() => {
    switch (purpose) {
      case 'planning':
        return 'planner';
      case 'research':
        return 'research';
      case 'review':
        return 'review';
      case 'design':
        return 'design';
      case 'execution':
        return 'executor';
      case 'oracle':
        return 'oracle';
      default:
        return 'delegate';
    }
  })();

  if (mode) {
    return `${HARNESS_MODES[mode]?.label ?? mode} · ${purposeRole}`;
  }

  return purposeRole.charAt(0).toUpperCase() + purposeRole.slice(1);
};

const buildDeliverablePrompt = (
  prompt: string,
  deliverable?: WorkflowArtifactKind,
  successCriteria?: string[],
): string => {
  if (!deliverable && (!successCriteria || successCriteria.length === 0)) {
    return prompt;
  }

  const sections = [prompt.trim()];
  if (deliverable) {
    sections.push(
      '',
      `Deliverable kind: ${deliverable}`,
      `Shape the response as a concise ${deliverable} deliverable rather than a generic answer.`,
    );
  }
  if (successCriteria && successCriteria.length > 0) {
    sections.push('', 'Success criteria:', ...successCriteria.map((criterion) => `- ${criterion}`));
  }

  return sections.join('\n');
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
      role: {
        type: 'string',
        description: 'Optional specialist role profile for the delegated worker.',
        enum: SPECIALIST_ROLES,
      },
      deliverable: {
        type: 'string',
        description: 'Requested deliverable kind for the delegated worker.',
        enum: DELIVERABLE_KINDS,
      },
      success_criteria: {
        type: 'array',
        description: 'Optional success criteria the delegated worker should satisfy.',
        items: { type: 'string', description: 'A concrete success criterion.' },
      },
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
    const specialistRole =
      typeof args.role === 'string' && SPECIALIST_ROLES.includes(args.role as SpecialistRole)
        ? (args.role as SpecialistRole)
        : undefined;
    const deliverable =
      typeof args.deliverable === 'string' && DELIVERABLE_KINDS.includes(args.deliverable as WorkflowArtifactKind)
        ? (args.deliverable as WorkflowArtifactKind)
        : undefined;
    const successCriteria = Array.isArray(args.success_criteria)
      ? args.success_criteria.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const roleProfile = specialistRole ? getSpecialistRoleProfile(specialistRole) : null;
    const resolvedMode =
      mode ??
      (specialistRole && ctx.delegation
        ? resolveModeForSpecialistRole(specialistRole, ctx.delegation.listAvailableModes())
        : undefined);
    const effectiveMode = resolvedMode ?? undefined;
    const effectivePurpose = purpose ?? roleProfile?.purpose;
    const effectiveDeliverable = deliverable ?? roleProfile?.deliverable;
    const delegatedPrompt = buildDeliverablePrompt(args.prompt, effectiveDeliverable, successCriteria);

    if (ctx.delegation) {
      const activityId = randomUUID();
      ctx.onAgentActivity?.({
        id: activityId,
        label: activityLabel(effectiveMode, effectivePurpose, specialistRole),
        status: 'running',
        mode: effectiveMode,
        purpose: effectivePurpose,
        detail: preview(args.prompt),
      });

      try {
        const contextSnapshot = ctx.contextSnapshot
          ? await ctx.contextSnapshot(args.prompt, effectivePurpose)
          : undefined;
        const artifacts = ctx.artifacts?.(effectivePurpose ?? 'general', 4);
        const result = await ctx.delegation.run(
          {
            prompt: delegatedPrompt,
            purpose: effectivePurpose,
            requestedArtifactKind: effectiveDeliverable,
            successCriteria,
            roleProfile: specialistRole ?? null,
            taskLabel: args.prompt,
            preferredMode: effectiveMode,
            preferredModel: model,
            systemPrompt:
              specialistRole && !systemPrompt
                ? buildSpecialistPrompt(specialistRole, args.prompt, successCriteria)
                : systemPrompt,
            parentSessionId: ctx.sessionId,
            cwd: ctx.cwd,
            isolatedLabel: `task-${specialistRole ?? effectivePurpose ?? effectiveMode ?? 'general'}`,
            contextSnapshot,
            artifacts,
          },
          {
            onText: (text: string) => {
              ctx.onProgress?.(text);
              if (text.trim()) {
                ctx.onAgentActivity?.({
                  id: activityId,
                  label: activityLabel(effectiveMode, effectivePurpose, specialistRole),
                  status: 'running',
                  mode: effectiveMode,
                  purpose: effectivePurpose,
                  detail: preview(text, 64),
                });
              }
            },
            onVerificationState: (state) => {
              ctx.onAgentActivity?.({
                id: activityId,
                label: activityLabel(effectiveMode, effectivePurpose, specialistRole),
                status:
                  state.status === 'running'
                    ? 'verifying'
                    : state.status === 'passed' || state.status === 'skipped'
                      ? 'done'
                      : 'error',
                mode: effectiveMode,
                purpose: effectivePurpose,
                detail: state.summary,
              });
            },
            signal: ctx.abortSignal,
          },
        );

        ctx.onAgentActivity?.({
          id: activityId,
          label: activityLabel(result.mode, result.purpose, specialistRole),
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
            deliverable: effectiveDeliverable,
            successCriteria,
            verification: result.verification,
            usage: result.usage,
            durationMs: result.durationMs,
          },
        };
      } catch (error: unknown) {
        ctx.onAgentActivity?.({
          id: activityId,
          label: activityLabel(effectiveMode, effectivePurpose, specialistRole),
          status: 'error',
          mode: effectiveMode,
          purpose: effectivePurpose,
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

    const { SubAgentPool } = await import('../core/sub-agent.js');
    const pool = new SubAgentPool({
      token,
      baseUrl: ctx.authBaseUrl || resolveBaseUrl(),
      defaultModel: 'claude-sonnet-4-6',
      defaultSystemPrompt: 'You are a focused sub-agent. Complete the task precisely.',
    });

    const taskId = randomUUID();
    ctx.onAgentActivity?.({
      id: taskId,
      label: activityLabel(effectiveMode, effectivePurpose, specialistRole),
      status: 'running',
      mode: effectiveMode,
      purpose: effectivePurpose,
      detail: preview(args.prompt),
    });

    const result = await pool.runTask(
      {
        id: taskId,
        prompt: delegatedPrompt,
        role: 'general',
        model,
      },
      (text) => {
        ctx.onProgress?.(text);
        if (text.trim()) {
          ctx.onAgentActivity?.({
            id: taskId,
            label: activityLabel(effectiveMode, effectivePurpose, specialistRole),
            status: 'running',
            mode: effectiveMode,
            purpose: effectivePurpose,
            detail: preview(text, 64),
          });
        }
      },
      ctx.abortSignal,
    );

    if (result.status !== 'completed') {
      ctx.onAgentActivity?.({
        id: taskId,
        label: activityLabel(effectiveMode, effectivePurpose, specialistRole),
        status: 'error',
        mode: effectiveMode,
        purpose: effectivePurpose,
        detail: result.error ?? `Sub-agent ${result.status}`,
      });
      return {
        output: result.error ?? `Sub-agent failed with status: ${result.status}`,
        isError: true,
        metadata: {
          taskId,
          status: result.status,
          deliverable: effectiveDeliverable,
          successCriteria,
          usage: result.usage,
          durationMs: result.durationMs,
        },
      };
    }

    ctx.onAgentActivity?.({
      id: taskId,
      label: activityLabel(effectiveMode, effectivePurpose, specialistRole),
      status: 'done',
      mode: effectiveMode,
      purpose: effectivePurpose,
      detail: preview(result.text, 64),
    });

    return {
      output: result.text,
      metadata: {
        taskId,
        status: result.status,
        deliverable: effectiveDeliverable,
        successCriteria,
        usage: result.usage,
        durationMs: result.durationMs,
      },
    };
  },
};
