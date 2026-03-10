import type { ToolStateUpdate } from '../api/anthropic-client.js';
import type {
  DelegationHandlers,
  DelegationPurpose,
  DelegationResult,
  DelegationRuntime,
} from './delegation.js';
import {
  formatSpecialistLabel,
  getSpecialistRoleProfile,
  type SpecialistRole,
} from './specialist-roles.js';
import { TeamOrchestrator, type AgentRole, type TeamMessage, type TeamResult } from './team-agent.js';
import type { NamedMode } from './types.js';
import type { VerificationSummary } from './verifier.js';
import type { WorkflowArtifact } from './workflow-state.js';

const previewText = (value: string, maxLength: number = 96): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

export const formatTeamAgentLabel = (agent: {
  name: string;
  mode?: NamedMode;
  role: 'lead' | 'worker' | 'reviewer';
  roleProfile?: SpecialistRole;
}): string => {
  if (agent.roleProfile) {
    return formatSpecialistLabel(agent.roleProfile, agent.mode);
  }

  return `${agent.name} · ${agent.role}`;
};

export const formatTeamAgentDetail = (
  agent: Pick<AgentRole, 'taskLabel' | 'role' | 'roleProfile'>,
  fallback: string,
): string => agent.taskLabel?.trim() || fallback;

export const isRunnableTeamAgent = (agent: { role: 'lead' | 'worker' | 'reviewer' }): boolean =>
  agent.role !== 'lead';

export const teamAgentPurpose = (agent: Pick<AgentRole, 'role' | 'roleProfile'>): DelegationPurpose =>
  agent.roleProfile
    ? getSpecialistRoleProfile(agent.roleProfile).purpose
    : agent.role === 'lead' || agent.role === 'reviewer'
      ? 'review'
      : 'execution';

export interface TeamRunInput {
  name: string;
  task: string;
  strategy: 'parallel' | 'sequential' | 'delegate';
  agents: AgentRole[];
  sharedContext: string;
  signal: AbortSignal;
  maxRounds?: number;
  runAgent: (agent: AgentRole, input: string, round: number) => Promise<string>;
  onMessage?: (message: TeamMessage) => void;
}

export interface TeamExecutionActivitySnapshot {
  label: string;
  mode?: NamedMode | null;
  purpose?: string | null;
  status: 'queued' | 'running' | 'verifying' | 'done' | 'error';
  detail?: string | null;
  workspacePath?: string | null;
  updatedAt?: number;
}

export interface FormattedTeamResultInput {
  strategy: 'parallel' | 'sequential' | 'delegate';
  task: string;
  agents: AgentRole[];
  messages: TeamMessage[];
  output: string;
  success: boolean;
  rounds: number;
  isolatedNotes: string[];
}

export interface TeamAgentDelegationInput {
  runtime: DelegationRuntime;
  agent: AgentRole;
  input: string;
  round: number;
  signal: AbortSignal;
  maxTokens?: number;
  parentSessionId?: string | null;
  cwd: string;
  contextSnapshot?: string;
  artifacts?: WorkflowArtifact[];
  onApiCallStart?: DelegationHandlers['onApiCallStart'];
  onApiCallComplete?: DelegationHandlers['onApiCallComplete'];
  onText?: (delta: string) => void;
  onToolState?: (states: ToolStateUpdate[]) => void;
  onVerificationState?: (state: VerificationSummary | { status: 'running'; summary?: string }) => void;
  onExecutionState?: (detail: string) => void;
}

export interface TeamAgentDelegationResult extends DelegationResult {
  output: string;
}

const activityStatusPriority = (status: TeamExecutionActivitySnapshot['status']): number => {
  if (status === 'running' || status === 'verifying') {
    return 0;
  }
  if (status === 'queued') {
    return 1;
  }
  if (status === 'error') {
    return 2;
  }
  return 3;
};

const activityStatusLabel = (status: TeamExecutionActivitySnapshot['status']): string => {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'verifying':
      return 'verifying';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
  }
};

const purposeLabel = (purpose?: string | null): string | null => {
  if (!purpose) {
    return null;
  }

  if (purpose === 'research') {
    return 'research';
  }
  if (purpose === 'execution') {
    return 'execution';
  }
  if (purpose === 'review') {
    return 'review';
  }
  if (purpose === 'planning') {
    return 'planning';
  }
  if (purpose === 'design') {
    return 'design';
  }

  return purpose.replace(/_/g, ' ');
};

export const runTeamAgentDelegation = async (
  input: TeamAgentDelegationInput,
): Promise<TeamAgentDelegationResult> => {
  const roleVerificationMode = input.agent.roleProfile
    ? getSpecialistRoleProfile(input.agent.roleProfile).verificationMode
    : input.agent.role === 'reviewer'
      ? 'checks'
      : 'none';
  const result = await input.runtime.run(
    {
      prompt: [`Round ${input.round}`, `Team task context for ${input.agent.name}:`, input.input].join('\n\n'),
      purpose: teamAgentPurpose(input.agent),
      preferredMode: input.agent.mode,
      preferredModel: input.agent.model,
      roleProfile: input.agent.roleProfile ?? null,
      taskLabel: input.agent.taskLabel ?? null,
      systemPrompt: input.agent.systemPrompt,
      maxTokens: input.maxTokens,
      parentSessionId: input.parentSessionId,
      cwd: input.cwd,
      isolatedLabel: `team-${input.agent.id}-r${input.round}`,
      verificationMode: roleVerificationMode,
      readOnly: input.agent.readOnly,
      contextSnapshot: input.contextSnapshot,
      artifacts: input.artifacts ?? [],
    },
    {
      signal: input.signal,
      onApiCallStart: input.onApiCallStart,
      onApiCallComplete: input.onApiCallComplete,
      onText: input.onText,
      onToolState: input.onToolState,
      onVerificationState: input.onVerificationState,
      onExecutionState: input.onExecutionState,
    },
  );

  return {
    ...result,
    output: result.text.trim() || `[${input.agent.name}] no output`,
  };
};

export class TeamExecutionRuntime {
  public async run(input: TeamRunInput): Promise<TeamResult> {
    const orchestrator = new TeamOrchestrator({
      name: input.name,
      agents: input.agents,
      strategy: input.strategy,
      maxRounds: input.maxRounds ?? 2,
      sharedContext: input.sharedContext,
      runAgent: input.runAgent,
      onMessage: input.onMessage,
    });

    return orchestrator.run(input.task, input.signal);
  }

  public formatProgress(message: TeamMessage): string {
    const meta = message.metadata && Object.keys(message.metadata).length > 0
      ? ` ${JSON.stringify(message.metadata)}`
      : '';
    return [
      `team · ${message.type}`,
      `${message.from} → ${message.to}${meta}`,
      '',
      previewText(message.content, 320),
    ].join('\n');
  }

  public formatResult(input: FormattedTeamResultInput): string {
    const recentMessages = input.messages
      .slice(-6)
      .map((message) => `- ${message.from} -> ${message.to} [${message.type}] ${previewText(message.content, 92)}`);
    const assignments = input.agents
      .filter((agent) => isRunnableTeamAgent(agent))
      .map((agent) =>
        [
          `- ${formatTeamAgentLabel(agent)}: ${agent.taskLabel ?? agent.role}`,
          agent.dependencyLabels && agent.dependencyLabels.length > 0
            ? `after ${agent.dependencyLabels.join(', ')}`
            : null,
          agent.handoffTo ? `handoff ${agent.handoffTo}` : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join(' · '),
      );

    return [
      '# Team Run',
      '',
      `status: ${input.success ? 'success' : 'incomplete'}`,
      `strategy: ${input.strategy}`,
      `rounds: ${input.rounds}`,
      `task: ${input.task}`,
      `agents: ${input.agents.map((agent) => `${agent.name}/${agent.model}`).join(', ')}`,
      '',
      '## Assignments',
      ...(assignments.length > 0 ? assignments : ['- No specialist assignments recorded.']),
      '',
      '## Final Output',
      input.output.trim() || 'No final output.',
      '',
      '## Recent Coordination',
      ...(recentMessages.length > 0 ? recentMessages : ['- No coordination messages recorded.']),
      ...(input.isolatedNotes.length > 0
        ? ['', '## Isolated Runs', ...input.isolatedNotes]
        : []),
    ].join('\n');
  }

  public formatLiveStatus(input: {
    strategy: 'parallel' | 'sequential' | 'delegate';
    task: string;
    elapsedMs: number;
    agentActivities: TeamExecutionActivitySnapshot[];
  }): string {
    const counts = {
      queued: 0,
      running: 0,
      verifying: 0,
      done: 0,
      error: 0,
    };
    for (const activity of input.agentActivities) {
      counts[activity.status] += 1;
    }

    const liveActivities = input.agentActivities
      .slice()
      .sort((left, right) => {
        return (
          activityStatusPriority(left.status) - activityStatusPriority(right.status) ||
          (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
        );
      })
      .slice(0, 6);

    const summary = [
      counts.running > 0 ? `${counts.running} running` : null,
      counts.verifying > 0 ? `${counts.verifying} verifying` : null,
      counts.queued > 0 ? `${counts.queued} queued` : null,
      counts.done > 0 ? `${counts.done} done` : null,
      counts.error > 0 ? `${counts.error} error` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' · ');

    const workerLines = liveActivities.map((activity) => {
      const title = [activity.mode ? activity.mode.toUpperCase() : activity.label, purposeLabel(activity.purpose)]
        .filter((part): part is string => Boolean(part))
        .join(' · ');
      const detail = activity.detail?.trim() || activity.workspacePath?.trim() || 'working';
      return `- ${title || activity.label} · ${activityStatusLabel(activity.status)} · ${previewText(detail, 96)}`;
    });

    const elapsedSeconds = Math.max(1, Math.round(input.elapsedMs / 1000));

    return [
      '# Team Run',
      '',
      `status: running`,
      `strategy: ${input.strategy}`,
      `elapsed: ${elapsedSeconds}s`,
      `task: ${input.task}`,
      `workers: ${summary || 'coordinating agents'}`,
      '',
      '## Live Status',
      ...(workerLines.length > 0 ? workerLines : ['- Waiting for worker updates.']),
    ].join('\n');
  }
}
