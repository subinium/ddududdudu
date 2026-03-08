import { discoverAllProviders } from '../auth/discovery.js';
import { loadConfig } from './config.js';
import { BackgroundJobStore, resolveBackgroundJobDirectory, type BackgroundJobAgentActivity, type BackgroundJobRecord } from './background-jobs.js';
import { DelegationRuntime, type DelegationCredentials, type DelegationPurpose } from './delegation.js';
import { SessionManager } from './session.js';
import { TeamOrchestrator, type AgentRole, type TeamMessage } from './team-agent.js';
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
}): WorkflowArtifact => ({
  id: `job-artifact-${Date.now().toString(36)}`,
  kind: input.kind,
  title: input.title.trim(),
  summary: previewText(input.summary, 220),
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
    existing.status = next.status;
    existing.detail = next.detail;
    existing.workspacePath = next.workspacePath;
    existing.updatedAt = next.updatedAt;
    return activities;
  }

  return [next, ...activities].slice(0, 12);
};

const formatTeamProgress = (message: TeamMessage): string =>
  `${message.type} · ${message.from} → ${message.to} · ${previewText(message.content, 120)}`;

const formatTeamResult = (
  strategy: 'parallel' | 'sequential' | 'delegate',
  task: string,
  output: string,
  success: boolean,
  rounds: number,
): string =>
  [
    `Team run · ${strategy}`,
    `task: ${task}`,
    `status: ${success ? 'ok' : 'incomplete'}`,
    `rounds: ${rounds}`,
    '',
    output.trim(),
  ].join('\n');

const verificationModeForJob = (job: BackgroundJobRecord): VerificationMode =>
  job.verificationMode ?? (job.purpose === 'execution' || job.purpose === 'review' ? 'checks' : 'none');

const resolvePreferredMode = (job: BackgroundJobRecord): NamedMode | undefined =>
  job.preferredMode ?? undefined;

export const runDetachedBackgroundJob = async (jobId: string): Promise<void> => {
  const config = await loadConfig();
  const store = new BackgroundJobStore(resolveBackgroundJobDirectory(config.session.directory));
  const sessionManager = new SessionManager(config.session.directory);
  const job = await store.load(jobId);

  if (job.status === 'done' || job.status === 'error') {
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
  });

  let current = await store.update(job.id, {
    status: 'running',
    pid: process.pid,
    startedAt: job.startedAt ?? Date.now(),
    finishedAt: null,
    detail: job.detail ?? 'starting…',
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
      status: 'error',
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
            queuePersist({ detail: latestDetail });
          },
          onToolState: (states) => {
            const activeTool = states.find((state) => state.status === 'running') ?? states[states.length - 1];
            if (!activeTool) {
              return;
            }
            queuePersist({ detail: `${activeTool.name} ${activeTool.status}` });
          },
          onVerificationState: (state) => {
            const activity = updateActivity(current.agentActivities, {
              id: `job:${current.id}:route`,
              label: 'route',
              mode: current.preferredMode ?? null,
              purpose: current.purpose ?? 'general',
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
            });
          },
        },
      );

      const finalText = result.text.trim() || '[background delegate] no output';
      const artifact = buildArtifact({
        kind: artifactKindForPurpose(result.purpose),
        title: `${result.mode} ${result.purpose ?? 'general'}`,
        summary: finalText,
        source: 'delegate',
        mode: result.mode,
      });

      await sessionManager.append(
        current.sessionId ?? (await sessionManager.create({ provider: result.provider, model: result.model })).id,
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
        agentActivities: updateActivity(current.agentActivities, {
          id: `job:${current.id}:route`,
          label: result.mode,
          mode: result.mode,
          purpose: result.purpose ?? 'general',
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
      const runId = current.id;
      const orchestrator = new TeamOrchestrator({
        name: 'ddudu-detached-team',
        agents: teamAgents,
        strategy: current.strategy ?? 'parallel',
        maxRounds: 2,
        sharedContext: current.teamSharedContext ?? `cwd=${current.cwd}`,
        runAgent: async (agent, input, round) => {
          const purpose: DelegationPurpose =
            agent.role === 'lead' || agent.role === 'reviewer' ? 'review' : 'execution';

          queuePersist({
            agentActivities: updateActivity(current.agentActivities, {
              id: `job:${current.id}:${agent.id}:${round}`,
              label: agent.name,
              mode: agent.mode ?? null,
              purpose,
              status: 'running',
              detail: `round ${round} · ${agent.role}`,
              workspacePath: null,
              updatedAt: Date.now(),
            }),
            detail: `${agent.name} · round ${round}`,
          });

          const result = await runtime.run(
            {
              prompt: [`Round ${round}`, `Team task context for ${agent.name}:`, input].join('\n\n'),
              purpose,
              preferredMode: agent.mode,
              preferredModel: agent.model,
              systemPrompt: agent.systemPrompt,
              maxTokens: getMaxTokens(config),
              parentSessionId: current.sessionId,
              cwd: current.cwd,
              isolatedLabel: `team-${agent.id}-r${round}`,
              verificationMode: agent.role === 'worker' || agent.role === 'reviewer' ? 'checks' : 'none',
              contextSnapshot: current.contextSnapshot ?? undefined,
              artifacts: current.artifacts ?? [],
            },
            {
              signal: abortController.signal,
              onText: (delta) => {
                if (!delta.trim()) {
                  return;
                }
                queuePersist({
                  agentActivities: updateActivity(current.agentActivities, {
                    id: `job:${current.id}:${agent.id}:${round}`,
                    label: agent.name,
                    mode: agent.mode ?? null,
                    purpose,
                    status: 'running',
                    detail: previewText(delta, 64),
                    workspacePath: null,
                    updatedAt: Date.now(),
                  }),
                  detail: `${agent.name} · ${previewText(delta, 64)}`,
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
                    label: agent.name,
                    mode: agent.mode ?? null,
                    purpose,
                    status: 'running',
                    detail: `${activeTool.name} ${activeTool.status}`,
                    workspacePath: null,
                    updatedAt: Date.now(),
                  }),
                  detail: `${agent.name} · ${activeTool.name} ${activeTool.status}`,
                });
              },
              onVerificationState: (state) => {
                queuePersist({
                  agentActivities: updateActivity(current.agentActivities, {
                    id: `job:${current.id}:${agent.id}:${round}`,
                    label: agent.name,
                    mode: agent.mode ?? null,
                    purpose,
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
                });
              },
            },
          );

          if (result.workspace) {
            backgroundNotes.push(`${agent.name} · ${result.workspace.kind} · ${result.workspace.path}`);
          }

          return result.text.trim() || `[${agent.name}] no output`;
        },
        onMessage: (message) => {
          queuePersist({ detail: formatTeamProgress(message) });
        },
      });

      const result = await orchestrator.run(current.prompt, abortController.signal);
      const finalText = formatTeamResult(
        current.strategy ?? 'parallel',
        current.prompt,
        result.output,
        result.success,
        result.rounds,
      );
      const artifact = buildArtifact({
        kind: 'answer',
        title: `team ${current.strategy ?? 'parallel'}`,
        summary: result.output,
        source: 'team',
      });

      await sessionManager.append(
        current.sessionId ?? (await sessionManager.create({ title: 'background-team' })).id,
        buildSessionEntry(current, finalText, {
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
      });
    }

    await persistChain;
  } catch (error: unknown) {
    const detail = abortController.signal.aborted ? current.detail ?? 'background job aborted' : serializeError(error);
    current = await store.update(current.id, {
      status: 'error',
      detail,
      finishedAt: Date.now(),
      pid: null,
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
