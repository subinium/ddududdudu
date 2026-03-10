import { discoverAllProviders } from '../auth/discovery.js';
import { buildArtifactPayload } from './artifacts.js';
import { loadConfig } from './config.js';
import {
  BackgroundJobStore,
  resolveBackgroundJobDirectory,
  type BackgroundJobAgentActivity,
  type BackgroundJobChecklistItem,
  type BackgroundJobRecord,
} from './background-jobs.js';
import { DelegationRuntime, type DelegationCredentials, type DelegationPurpose } from './delegation.js';
import { SessionManager } from './session.js';
import {
  TeamExecutionRuntime,
  formatTeamAgentDetail,
  formatTeamAgentLabel,
  runTeamAgentDelegation,
  teamAgentPurpose,
} from './team-execution.js';
import type { TeamMessage } from './team-agent.js';
import type { NamedMode, SessionEntry } from './types.js';
import type { VerificationMode, VerificationSummary } from './verifier.js';
import { WorktreeManager } from './worktree-manager.js';
import type { WorkflowArtifact, WorkflowArtifactKind } from './workflow-state.js';

const normalizeProviderMap = (
  providers: Map<string, DelegationCredentials>,
): Map<string, DelegationCredentials> => {
  const normalized = new Map(providers);
  const claude = normalized.get('claude');
  if (claude && !normalized.has('anthropic')) {
    normalized.set('anthropic', claude);
  }

  const codex = normalized.get('codex');
  if (codex && !normalized.has('openai')) {
    normalized.set('openai', codex);
  }

  return normalized;
};

const serializeError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
};

const getMaxTokens = (config: Awaited<ReturnType<typeof loadConfig>>): number | undefined => {
  const maybeAgent = config.agent as unknown as Record<string, unknown>;
  const value = maybeAgent.max_tokens;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return undefined;
};

const normalizeSingleLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

const previewText = (value: string, maxLength: number = 96): string => {
  const normalized = normalizeSingleLine(value);
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const artifactKindForPurpose = (purpose?: DelegationPurpose | 'general'): WorkflowArtifactKind => {
  switch (purpose) {
    case 'execution':
      return 'patch';
    case 'planning':
      return 'plan';
    case 'review':
    case 'oracle':
      return 'review';
    case 'design':
      return 'design';
    case 'research':
      return 'research';
    default:
      return 'answer';
  }
};

const buildArtifact = (input: {
  kind: WorkflowArtifactKind;
  title: string;
  summary: string;
  source: 'delegate' | 'team' | 'session';
  mode?: NamedMode;
  payload?: WorkflowArtifact['payload'];
}): WorkflowArtifact => ({
  id: `job-artifact-${Date.now().toString(36)}`,
  kind: input.kind,
  title: input.title.trim(),
  summary: previewText(input.summary, 220),
  payload: input.payload,
  source: input.source,
  mode: input.mode,
  createdAt: new Date().toISOString(),
});

const buildSessionEntry = (
  job: BackgroundJobRecord,
  resultText: string,
  metadata: Record<string, unknown>,
): SessionEntry => ({
  type: 'message',
  timestamp: new Date().toISOString(),
  data: {
    user: job.prompt,
    assistant: resultText,
    requestMode: `${job.kind}_background_detached`,
    purpose: job.purpose,
    ...metadata,
  },
});

const updateActivity = (
  activities: BackgroundJobAgentActivity[],
  next: BackgroundJobAgentActivity,
): BackgroundJobAgentActivity[] => {
  const existing = activities.find((activity) => activity.id === next.id);
  if (existing) {
    existing.label = next.label;
    existing.mode = next.mode;
    existing.purpose = next.purpose;
    existing.checklistId = next.checklistId ?? existing.checklistId ?? null;
    existing.status = next.status;
    existing.detail = next.detail;
    existing.workspacePath = next.workspacePath;
    existing.updatedAt = next.updatedAt;
    return activities;
  }

  return [next, ...activities].slice(0, 12);
};

const updateChecklistItem = (
  items: BackgroundJobChecklistItem[],
  id: string,
  patch: Partial<BackgroundJobChecklistItem>,
): BackgroundJobChecklistItem[] =>
  items.map((item) =>
    item.id === id
      ? {
          ...item,
          ...patch,
          id: item.id,
          updatedAt: Date.now(),
        }
      : item,
  );

const formatTeamProgress = (message: TeamMessage): string =>
  `${message.type} · ${message.from} → ${message.to} · ${previewText(message.content, 120)}`;

const verificationModeForJob = (job: BackgroundJobRecord): VerificationMode =>
  job.verificationMode ?? (job.purpose === 'execution' || job.purpose === 'review' ? 'checks' : 'none');

const resolvePreferredMode = (job: BackgroundJobRecord): NamedMode | undefined =>
  job.preferredMode ?? undefined;

export class BackgroundExecutionService {
  public async run(jobId: string): Promise<void> {
    await runDetachedBackgroundJob(jobId);
  }
}

export const runDetachedBackgroundJob = async (jobId: string): Promise<void> => {
  const config = await loadConfig();
  const store = new BackgroundJobStore(resolveBackgroundJobDirectory(config.session.directory));
  const sessionManager = new SessionManager(config.session.directory);
  const job = await store.load(jobId);

  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
    return;
  }

  const providers = normalizeProviderMap(
    new Map(
      Array.from((await discoverAllProviders()).entries()).map(([name, auth]) => [
        name,
        { token: auth.token, tokenType: auth.tokenType, source: auth.source },
      ]),
    ),
  );

  const worktreeManager = new WorktreeManager(job.cwd);
  const runtime = new DelegationRuntime({
    cwd: job.cwd,
    availableProviders: providers,
    sessionManager,
    worktreeManager,
    executionSchedulerConfig: {
      providerBudgets: config.agent.provider_budgets,
      maxParallelWrites: config.agent.max_parallel_writes,
      pollMs: config.agent.scheduler_poll_ms,
    },
  });

  let current = await store.update(job.id, {
    status: 'running',
    pid: process.pid,
    startedAt: job.startedAt ?? Date.now(),
    finishedAt: null,
    detail: job.detail ?? 'starting…',
    checklist:
      job.kind === 'delegate'
        ? updateChecklistItem(job.checklist, 'execute', {
            status: 'in_progress',
            detail: job.label ? `starting ${job.label}` : 'starting delegated worker',
          })
        : job.checklist,
  });

  let persistChain = Promise.resolve();
  const queuePersist = (patch: Partial<BackgroundJobRecord>): void => {
    persistChain = persistChain
      .then(async () => {
        current = await store.update(job.id, patch);
      })
      .catch(() => undefined);
  };

  const abortController = new AbortController();
  const handleTerminate = (signal: NodeJS.Signals): void => {
    abortController.abort();
    queuePersist({
      status: 'cancelled',
      detail: `cancelled by ${signal.toLowerCase()}`,
      finishedAt: Date.now(),
      pid: null,
    });
  };

  process.on('SIGTERM', handleTerminate);
  process.on('SIGINT', handleTerminate);

  try {
    if (current.kind === 'delegate') {
      let latestDetail = current.detail ?? previewText(current.prompt, 72);
      const result = await runtime.run(
        {
          prompt: current.prompt,
          purpose: current.purpose,
          preferredMode: resolvePreferredMode(current),
          preferredModel: current.preferredModel ?? undefined,
          parentSessionId: current.sessionId,
          cwd: current.cwd,
          isolatedLabel: `background-${current.preferredMode ?? current.purpose ?? 'general'}`,
          applyWorkspaceChanges: current.purpose === 'execution' || current.purpose === 'design',
          readOnly: !(current.purpose === 'execution' || current.purpose === 'design'),
          verificationMode: verificationModeForJob(current),
          contextSnapshot: current.contextSnapshot ?? undefined,
          artifacts: current.artifacts ?? [],
          maxTokens: getMaxTokens(config),
        },
        {
          signal: abortController.signal,
          onText: (delta) => {
            if (!delta.trim()) {
              return;
            }
            latestDetail = previewText(delta, 72);
            queuePersist({
              agentActivities: updateActivity(current.agentActivities, {
                id: `job:${current.id}:delegate`,
                label: current.preferredMode ?? 'delegate',
                mode: current.preferredMode ?? null,
                purpose: current.purpose ?? 'general',
                checklistId: 'execute',
                status: 'running',
                detail: latestDetail,
                workspacePath: null,
                updatedAt: Date.now(),
              }),
              detail: latestDetail,
              checklist: updateChecklistItem(current.checklist, 'execute', {
                status: 'in_progress',
                detail: latestDetail,
              }),
            });
          },
          onToolState: (states) => {
            const activeTool = states.find((state) => state.status === 'running') ?? states[states.length - 1];
            if (!activeTool) {
              return;
            }
            queuePersist({
              agentActivities: updateActivity(current.agentActivities, {
                id: `job:${current.id}:delegate`,
                label: current.preferredMode ?? 'delegate',
                mode: current.preferredMode ?? null,
                purpose: current.purpose ?? 'general',
                checklistId: 'execute',
                status: 'running',
                detail: `${activeTool.name} ${activeTool.status}`,
                workspacePath: null,
                updatedAt: Date.now(),
              }),
              detail: `${activeTool.name} ${activeTool.status}`,
              checklist: updateChecklistItem(current.checklist, 'execute', {
                status: 'in_progress',
                detail: `${activeTool.name} ${activeTool.status}`,
              }),
            });
          },
          onVerificationState: (state) => {
            const activity = updateActivity(current.agentActivities, {
              id: `job:${current.id}:delegate`,
              label: current.preferredMode ?? 'delegate',
              mode: current.preferredMode ?? null,
              purpose: current.purpose ?? 'general',
              checklistId: 'verify',
              status:
                state.status === 'running'
                  ? 'verifying'
                  : state.status === 'passed' || state.status === 'skipped'
                    ? 'done'
                    : 'error',
              detail: state.summary ?? null,
              workspacePath: null,
              updatedAt: Date.now(),
            });
            queuePersist({
              agentActivities: activity,
              detail: state.summary ?? current.detail,
              checklist: updateChecklistItem(
                updateChecklistItem(current.checklist, 'execute', {
                  status: state.status === 'running' ? 'completed' : current.checklist.find((item) => item.id === 'execute')?.status ?? 'completed',
                  detail: current.checklist.find((item) => item.id === 'execute')?.detail ?? current.detail,
                }),
                'verify',
                {
                  status:
                    state.status === 'running'
                      ? 'in_progress'
                      : state.status === 'passed' || state.status === 'skipped'
                        ? 'completed'
                        : 'error',
                  detail: state.summary ?? null,
                },
              ),
            });
          },
          onExecutionState: (detail) => {
            queuePersist({
              agentActivities: updateActivity(current.agentActivities, {
                id: `job:${current.id}:delegate`,
                label: current.preferredMode ?? 'delegate',
                mode: current.preferredMode ?? null,
                purpose: current.purpose ?? 'general',
                checklistId: 'execute',
                status: 'queued',
                detail,
                workspacePath: null,
                updatedAt: Date.now(),
              }),
              detail,
              checklist: updateChecklistItem(current.checklist, 'execute', {
                status: 'blocked',
                detail,
              }),
            });
          },
        },
      );

      const finalText = result.text.trim() || '[background delegate] no output';
      const artifactKind = result.requestedArtifactKind ?? artifactKindForPurpose(result.purpose);
      const artifact = buildArtifact({
        kind: artifactKind,
        title: `${result.mode} ${result.purpose ?? 'general'}`,
        summary: finalText,
        source: 'delegate',
        mode: result.mode,
        payload: buildArtifactPayload({
          kind: artifactKind,
          purpose: result.purpose,
          task: current.prompt,
          summary: finalText,
          files: result.verification?.changedFiles,
          verification: result.verification,
          workspaceApply: result.workspaceApply
            ? {
                applied: result.workspaceApply.applied,
                empty: result.workspaceApply.empty,
                summary: result.workspaceApply.summary,
                error: result.workspaceApply.error,
                path: result.workspace?.path ?? null,
              }
            : null,
        }),
      });

      await sessionManager.append(
        current.sessionId ?? (await sessionManager.create({
          provider: result.provider,
          model: result.model,
          metadata: {
            mode: result.mode,
            purpose: result.purpose,
            background: true,
          },
        })).id,
        buildSessionEntry(current, finalText, {
          mode: result.mode,
          provider: result.provider,
          model: result.model,
          remoteSessionId: result.remoteSessionId,
          workspacePath: result.workspace?.path,
          workspaceApply: result.workspaceApply
            ? {
                attempted: result.workspaceApply.attempted,
                applied: result.workspaceApply.applied,
                empty: result.workspaceApply.empty,
                summary: result.workspaceApply.summary,
                error: result.workspaceApply.error,
              }
            : undefined,
          verification: result.verification
            ? {
                status: result.verification.status,
                summary: result.verification.summary,
                cwd: result.verification.cwd,
              }
            : undefined,
          inputTokens: result.usage.input,
          outputTokens: result.usage.output,
        }),
      );

      current = await store.update(current.id, {
        status: result.workspaceApply && !result.workspaceApply.applied && !result.workspaceApply.empty ? 'error' : 'done',
        detail:
          result.workspaceApply && !result.workspaceApply.applied && !result.workspaceApply.empty
            ? `apply failed · ${result.workspaceApply.error ?? result.workspaceApply.summary}`
            : result.workspaceApply?.applied
              ? `applied · ${result.workspaceApply.summary}`
              : result.verification?.summary ?? latestDetail,
        finishedAt: Date.now(),
        pid: null,
        result: {
          text: finalText,
          provider: result.provider,
          model: result.model,
          mode: result.mode,
          remoteSessionId: result.remoteSessionId ?? null,
          workspacePath: result.workspace?.path ?? null,
          workspaceApply: result.workspaceApply
            ? {
                attempted: result.workspaceApply.attempted,
                applied: result.workspaceApply.applied,
                empty: result.workspaceApply.empty,
                summary: result.workspaceApply.summary,
                error: result.workspaceApply.error,
              }
            : null,
          verification: result.verification ?? null,
          usage: result.usage,
        },
        artifact,
        checklist: [
          ...updateChecklistItem(current.checklist, 'execute', {
            status: 'completed',
            detail: result.verification?.summary ?? previewText(finalText, 72),
          }),
        ]
          .map((item) => {
            if (item.id === 'verify') {
              return {
                ...item,
                status:
                  result.verification?.status === 'failed'
                    ? 'error'
                    : result.verification
                      ? 'completed'
                      : item.status,
                detail: result.verification?.summary ?? item.detail,
                updatedAt: Date.now(),
              };
            }
            if (item.id === 'apply') {
              return {
                ...item,
                status:
                  result.workspaceApply && !result.workspaceApply.applied && !result.workspaceApply.empty
                    ? 'error'
                    : result.workspaceApply
                      ? 'completed'
                      : item.status,
                detail: result.workspaceApply?.summary ?? item.detail,
                updatedAt: Date.now(),
              };
            }
            return item;
          }),
        agentActivities: updateActivity(current.agentActivities, {
          id: `job:${current.id}:delegate`,
          label: result.mode,
          mode: result.mode,
          purpose: result.purpose ?? 'general',
          checklistId:
            result.workspaceApply && !result.workspaceApply.applied && !result.workspaceApply.empty
              ? 'apply'
              : result.verification
                ? 'verify'
                : 'execute',
          status:
            result.workspaceApply && !result.workspaceApply.applied && !result.workspaceApply.empty
              ? 'error'
              : result.verification?.status === 'failed'
                ? 'error'
                : 'done',
          detail:
            result.workspaceApply && !result.workspaceApply.applied && !result.workspaceApply.empty
              ? result.workspaceApply.error ?? result.workspaceApply.summary
              : result.verification?.summary ?? previewText(finalText, 72),
          workspacePath: result.workspace?.path ?? null,
          updatedAt: Date.now(),
        }),
      });
    } else {
      const teamAgents = current.teamAgents ?? [];
      if (teamAgents.length < 2) {
        throw new Error('Detached team run needs at least two configured agents.');
      }

      const backgroundNotes: string[] = [];
      const teamExecution = new TeamExecutionRuntime();
      const result = await teamExecution.run({
        name: 'ddudu-detached-team',
        agents: teamAgents,
        strategy: current.strategy ?? 'parallel',
        maxRounds: 2,
        sharedContext: current.teamSharedContext ?? `cwd=${current.cwd}`,
        task: current.prompt,
        signal: abortController.signal,
        runAgent: async (agent, input, round) => {
          const purpose: DelegationPurpose = teamAgentPurpose(agent);

          queuePersist({
            agentActivities: updateActivity(current.agentActivities, {
              id: `job:${current.id}:${agent.id}:${round}`,
              label: formatTeamAgentLabel(agent),
              mode: agent.mode ?? null,
              purpose,
              checklistId: `agent:${agent.id}`,
              status: 'running',
              detail: formatTeamAgentDetail(agent, `round ${round} · ${agent.roleProfile ?? agent.role}`),
              workspacePath: null,
              updatedAt: Date.now(),
            }),
            detail: `${formatTeamAgentLabel(agent)} · ${formatTeamAgentDetail(agent, `round ${round}`)}`,
            checklist: updateChecklistItem(current.checklist, `agent:${agent.id}`, {
              status: 'in_progress',
              detail: formatTeamAgentDetail(agent, `round ${round} · ${agent.roleProfile ?? agent.role}`),
            }),
          });

          const result = await runTeamAgentDelegation({
            runtime,
            agent,
            input,
            round,
            signal: abortController.signal,
            maxTokens: getMaxTokens(config),
            parentSessionId: current.sessionId,
            cwd: current.cwd,
            contextSnapshot: current.contextSnapshot ?? undefined,
            artifacts: current.artifacts ?? [],
            onText: (delta) => {
              if (!delta.trim()) {
                return;
              }
              queuePersist({
                agentActivities: updateActivity(current.agentActivities, {
                  id: `job:${current.id}:${agent.id}:${round}`,
                  label: formatTeamAgentLabel(agent),
                  mode: agent.mode ?? null,
                  purpose,
                  checklistId: `agent:${agent.id}`,
                  status: 'running',
                  detail: previewText(delta, 64),
                  workspacePath: null,
                  updatedAt: Date.now(),
                }),
                detail: `${agent.name} · ${previewText(delta, 64)}`,
                checklist: updateChecklistItem(current.checklist, `agent:${agent.id}`, {
                  status: 'in_progress',
                  detail: previewText(delta, 64),
                }),
              });
            },
            onToolState: (states) => {
              const activeTool = states.find((state) => state.status === 'running') ?? states[states.length - 1];
              if (!activeTool) {
                return;
              }
              queuePersist({
                agentActivities: updateActivity(current.agentActivities, {
                  id: `job:${current.id}:${agent.id}:${round}`,
                  label: formatTeamAgentLabel(agent),
                  mode: agent.mode ?? null,
                  purpose,
                  checklistId: `agent:${agent.id}`,
                  status: 'running',
                  detail: `${activeTool.name} ${activeTool.status}`,
                  workspacePath: null,
                  updatedAt: Date.now(),
                }),
                detail: `${agent.name} · ${activeTool.name} ${activeTool.status}`,
                checklist: updateChecklistItem(current.checklist, `agent:${agent.id}`, {
                  status: 'in_progress',
                  detail: `${activeTool.name} ${activeTool.status}`,
                }),
              });
            },
            onVerificationState: (state) => {
              queuePersist({
                agentActivities: updateActivity(current.agentActivities, {
                  id: `job:${current.id}:${agent.id}:${round}`,
                  label: formatTeamAgentLabel(agent),
                  mode: agent.mode ?? null,
                  purpose,
                  checklistId: `agent:${agent.id}`,
                  status:
                    state.status === 'running'
                      ? 'verifying'
                      : state.status === 'passed' || state.status === 'skipped'
                        ? 'done'
                        : 'error',
                  detail: state.summary ?? null,
                  workspacePath: null,
                  updatedAt: Date.now(),
                }),
                detail: state.summary ?? current.detail,
                checklist: updateChecklistItem(current.checklist, `agent:${agent.id}`, {
                  status:
                    state.status === 'running'
                      ? 'in_progress'
                      : state.status === 'passed' || state.status === 'skipped'
                        ? 'completed'
                        : 'error',
                  detail: state.summary ?? null,
                }),
              });
            },
            onExecutionState: (detail) => {
              queuePersist({
                agentActivities: updateActivity(current.agentActivities, {
                  id: `job:${current.id}:${agent.id}:${round}`,
                  label: formatTeamAgentLabel(agent),
                  mode: agent.mode ?? null,
                  purpose,
                  checklistId: `agent:${agent.id}`,
                  status: 'queued',
                  detail,
                  workspacePath: null,
                  updatedAt: Date.now(),
                }),
                detail: `${agent.name} · ${detail}`,
                checklist: updateChecklistItem(current.checklist, `agent:${agent.id}`, {
                  status: 'blocked',
                  detail,
                }),
              });
            },
          });

          if (result.workspace) {
            backgroundNotes.push(`${agent.name} · ${result.workspace.kind} · ${result.workspace.path}`);
          }

          queuePersist({
            agentActivities: updateActivity(current.agentActivities, {
              id: `job:${current.id}:${agent.id}:${round}`,
              label: formatTeamAgentLabel(agent),
              mode: agent.mode ?? null,
              purpose,
              checklistId: `agent:${agent.id}`,
              status: result.verification?.status === 'failed' ? 'error' : 'done',
              detail: result.verification?.summary ?? previewText(result.text, 64),
              workspacePath: result.workspace?.path ?? null,
              updatedAt: Date.now(),
            }),
            checklist: updateChecklistItem(current.checklist, `agent:${agent.id}`, {
              status: result.verification?.status === 'failed' ? 'error' : 'completed',
              detail: result.verification?.summary ?? previewText(result.text, 64),
            }),
          });

          return result.output;
        },
        onMessage: (message) => {
          queuePersist({
            detail: formatTeamProgress(message),
            checklist: updateChecklistItem(current.checklist, 'synthesize', {
              status: 'in_progress',
              detail: formatTeamProgress(message),
            }),
          });
        },
      });
      const finalText = teamExecution.formatResult({
        strategy: current.strategy ?? 'parallel',
        task: current.prompt,
        agents: teamAgents,
        messages: result.messages,
        output: result.output,
        success: result.success,
        rounds: result.rounds,
        isolatedNotes: backgroundNotes,
      });
      const artifact = buildArtifact({
        kind: 'briefing',
        title: `team ${current.strategy ?? 'parallel'}`,
        summary: result.output,
        source: 'team',
        payload: buildArtifactPayload({
          kind: 'briefing',
          purpose: current.purpose ?? 'general',
          task: current.prompt,
          summary: result.output,
          strategy: current.strategy ?? 'parallel',
          notes: backgroundNotes,
        }),
      });

      await sessionManager.append(
        current.sessionId ?? (await sessionManager.create({
          title: 'background-team',
          provider: teamAgents[0]?.provider,
          model: teamAgents[0]?.model,
          metadata: {
            mode: current.preferredMode ?? teamAgents[0]?.mode,
            purpose: current.purpose,
            background: true,
            strategy: current.strategy ?? 'parallel',
          },
        })).id,
        buildSessionEntry(current, finalText, {
          mode: current.preferredMode ?? teamAgents[0]?.mode,
          teamStrategy: current.strategy ?? 'parallel',
          teamAgents: teamAgents.map((agent) => ({
            id: agent.id,
            mode: agent.mode,
            model: agent.model,
          })),
          isolatedRuns: backgroundNotes,
        }),
      );

      current = await store.update(current.id, {
        status: 'done',
        detail: `${current.strategy ?? 'parallel'} · ${result.success ? 'ok' : 'incomplete'} · ${result.rounds} rounds`,
        finishedAt: Date.now(),
        pid: null,
        result: {
          text: finalText,
          provider: 'team',
          model: teamAgents.map((agent) => agent.model).join(', '),
        },
        artifact,
        checklist: current.checklist.map((item) => {
          if (item.id === 'synthesize') {
            return {
              ...item,
              status: 'completed',
              detail:
                item.detail ?? `${current.strategy ?? 'parallel'} · ${result.rounds} rounds`,
              updatedAt: Date.now(),
            };
          }
          if (item.id.startsWith('agent:') && (item.status === 'pending' || item.status === 'blocked')) {
            return {
              ...item,
              status: result.success ? 'completed' : item.status,
              detail: result.success ? `${current.strategy ?? 'parallel'} agent completed` : item.detail,
              updatedAt: Date.now(),
            };
          }
          return item;
        }),
      });
    }

    await persistChain;
  } catch (error: unknown) {
    const detail = abortController.signal.aborted ? current.detail ?? 'background job aborted' : serializeError(error);
    current = await store.update(current.id, {
      status: abortController.signal.aborted ? 'cancelled' : 'error',
      detail,
      finishedAt: Date.now(),
      pid: null,
      checklist: current.checklist.map((item) =>
        item.status === 'in_progress'
          ? {
              ...item,
              status: 'error',
              detail,
              updatedAt: Date.now(),
            }
          : item,
      ),
    });
    await persistChain;
    if (!abortController.signal.aborted) {
      throw error;
    }
  } finally {
    process.off('SIGTERM', handleTerminate);
    process.off('SIGINT', handleTerminate);
  }
};
