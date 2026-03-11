import { randomUUID } from 'node:crypto';

import { ChecksRunner } from '../../../core/checks.js';
import { GitCheckpoint } from '../../../core/git-checkpoint.js';
import { loadConfig } from '../../../core/config.js';
import { setDduduConfigValue } from '../../../core/config-editor.js';
import { formatArtifactForInspector } from '../../../core/artifacts.js';
import type { BackgroundJobRecord } from '../../../core/background-jobs.js';
import { HARNESS_MODES } from '../../shared/theme.js';

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

const summarizeChecklistProgress = (checklist: Array<{ status: string }>): string | null => {
  if (checklist.length === 0) {
    return null;
  }

  const completed = checklist.filter((item) => item.status === 'completed').length;
  const inProgress = checklist.filter((item) => item.status === 'in_progress').length;
  const blocked = checklist.filter((item) => item.status === 'blocked').length;
  const failed = checklist.filter((item) => item.status === 'error').length;
  const total = checklist.length;
  const detail = [
    `${completed}/${total} done`,
    inProgress > 0 ? `${inProgress} active` : null,
    blocked > 0 ? `${blocked} blocked` : null,
    failed > 0 ? `${failed} failed` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  return detail || `${completed}/${total} done`;
};

const getChecklistTodoRef = (checklist: Array<{ id: string }>, itemId: string): string | null => {
  const index = checklist.findIndex((item) => item.id === itemId);
  return index >= 0 ? `todo #${index + 1}` : null;
};

interface BackgroundJobStateLike {
  id: string;
  label: string;
  kind: 'delegate' | 'team';
  status: 'running' | 'done' | 'error' | 'cancelled';
  detail?: string | null;
  resultPreview?: string | null;
  workspacePath?: string | null;
  checklist: Array<{ id: string; label: string; status: string; owner?: string | null; detail?: string | null }>;
  artifactId?: string | null;
  artifactTitle?: string | null;
  prompt?: string | null;
  purpose?: 'general' | 'planning' | 'research' | 'review' | 'design' | 'execution' | 'oracle' | null;
  preferredMode?: 'jennie' | 'lisa' | 'rosé' | 'jisoo' | null;
  strategy?: 'parallel' | 'sequential' | 'delegate' | null;
  reason?: string | null;
  attempt?: number | null;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number | null;
  verificationSummary?: string | null;
  controller?: AbortController | null;
}

interface ArtifactLike {
  id: string;
}

export interface WorkspaceCommandDeps {
  todos: Array<{ id: string; step: string; status: string; owner?: string }>;
  artifacts: ArtifactLike[];
  queuedPrompts: string[];
  permissionProfile: string;
  config: { git_checkpoint?: boolean } | null;
  state: { loading: boolean };
  abortController: AbortController | null;
  backgroundJobStore: { update: (id: string, payload: Record<string, unknown>) => Promise<unknown> } | null;
  formatToolPolicySummary: () => string;
  formatNetworkTrustSummary: () => string;
  formatSecretTrustSummary: () => string;
  addStringListConfigValue: (path: string, value: string) => Promise<void>;
  removeStringListConfigValue: (path: string, value: string) => Promise<void>;
  setStringListConfigValue: (path: string, values: string[]) => Promise<void>;
  scheduleStatePush: () => void;
  setConfiguredToolPolicy: (name: string, policy: 'inherit' | 'allow' | 'ask' | 'deny') => Promise<void>;
  requestPermissionProfileChange: (
    profile: 'plan' | 'ask' | 'workspace-write' | 'permissionless',
    source: 'fire' | 'permissions',
  ) => Promise<boolean>;
  clearPlan: () => Promise<void>;
  addPlanItem: (step: string) => Promise<void>;
  updatePlanItem: (stepOrId: string, updates: { status?: 'in_progress' | 'completed' | 'pending'; owner?: string }) => Promise<void>;
  syncQueuedPrompts: () => void;
  formatQueueSummary: () => string;
  resolveQueueIndex: (value: string) => number;
  submit: (prompt: string) => Promise<void>;
  formatJobsSummary: () => Promise<string>;
  resolveBackgroundJob: (reference: string) => Promise<BackgroundJobStateLike>;
  getStoredBackgroundJob: (jobId: string) => Promise<BackgroundJobRecord | null>;
  waitForJobCompletion: (jobId: string, timeoutMs: number) => Promise<boolean>;
  pollBackgroundJobs: () => Promise<void>;
  canStartBackgroundJob: () => boolean;
  startBackgroundTeamRun: (
    strategy: 'parallel' | 'sequential' | 'delegate',
    task: string,
    options: { routeNote?: string; attempt?: number },
  ) => Promise<void>;
  startBackgroundDelegatedRoute: (
    message: { id: string; role: 'user'; content: string; timestamp: number },
    decision: {
      kind: 'delegate';
      purpose: 'general' | 'planning' | 'research' | 'review' | 'design' | 'execution' | 'oracle';
      preferredMode?: 'jennie' | 'lisa' | 'rosé' | 'jisoo';
      reason: string;
      repairAttempt: number;
    },
  ) => Promise<void>;
  formatJobInspect: (job: BackgroundJobStateLike) => string;
  formatJobResult: (job: BackgroundJobStateLike) => string;
  getArtifactById: (id: string | null | undefined) => ArtifactLike | null;
  executeTeamRun: (
    strategy: 'parallel' | 'sequential' | 'delegate',
    task: string,
    options: { routeNote?: string },
  ) => Promise<string>;
}

const isToolPolicy = (value: unknown): value is 'inherit' | 'allow' | 'ask' | 'deny' => {
  return value === 'inherit' || value === 'allow' || value === 'ask' || value === 'deny';
};

const isPermissionProfile = (value: unknown): value is 'plan' | 'ask' | 'workspace-write' | 'permissionless' => {
  return value === 'plan' || value === 'ask' || value === 'workspace-write' || value === 'permissionless';
};

const formatJobLogs = (job: BackgroundJobRecord): string => {
  const activities = job.agentActivities
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((activity) => {
      const todoRef = activity.checklistId ? getChecklistTodoRef(job.checklist, activity.checklistId) : null;
      const scope = [
        activity.mode ? HARNESS_MODES[activity.mode].label : activity.label,
        activity.purpose,
        activity.status,
        todoRef,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' · ');
      const detail = activity.detail ? ` · ${previewText(activity.detail, 180)}` : '';
      const workspace = activity.workspacePath ? ` · ${previewText(activity.workspacePath, 100)}` : '';
      return `- ${scope}${detail}${workspace}`;
    });

  return [
    `Job ${job.id}`,
    `label: ${job.label}`,
    `status: ${job.status}`,
    job.startedAt ? `started: ${new Date(job.startedAt).toISOString()}` : null,
    job.finishedAt ? `finished: ${new Date(job.finishedAt).toISOString()}` : null,
    job.attempt > 0 ? `attempt: ${job.attempt}` : null,
    job.detail ? `detail: ${job.detail}` : null,
    job.result?.workspacePath ? `workspace: ${job.result.workspacePath}` : null,
    job.result?.workspaceApply
      ? `apply: ${job.result.workspaceApply.applied ? 'applied' : job.result.workspaceApply.empty ? 'empty' : 'failed'} · ${job.result.workspaceApply.summary}${job.result.workspaceApply.error ? ` · ${job.result.workspaceApply.error}` : ''}`
      : null,
    '',
    'Checklist:',
    ...(job.checklist.length > 0
      ? job.checklist.map(
        (item) => `- [${item.status}] ${item.label}${item.owner ? ` · ${item.owner}` : ''}${item.detail ? ` · ${previewText(item.detail, 120)}` : ''}`,
      )
      : ['- no recorded checklist']),
    '',
    'Agent activity:',
    ...(activities.length > 0 ? activities : ['- no recorded agent activity']),
    '',
    'Result preview:',
    ...(job.artifact ? formatArtifactForInspector(job.artifact) : [job.result?.text ? previewText(job.result.text, 500) : 'no stored result']),
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n');
};

export const formatPlanSummary = (deps: WorkspaceCommandDeps): string => {
  if (deps.todos.length === 0) {
    return 'plan: none';
  }

  return [
    'plan:',
    ...deps.todos.map((item, index) => `${index + 1}. [${item.status}] ${item.step}${item.owner ? ` · ${item.owner}` : ''}`),
  ].join('\n');
};

export const runPermissionsCommand = async (args: string[], deps: WorkspaceCommandDeps): Promise<string> => {
  const requested = args[0]?.trim().toLowerCase();
  if (!requested) {
    return [
      'Permissions',
      `current: ${deps.permissionProfile}`,
      'profiles:',
      '- plan · read-only',
      '- ask · prompt for any non-read tool',
      '- workspace-write · auto-allow local edits, prompt for network/secrets/delegation',
      '- permissionless · allow all except hard-blocked shell patterns',
      '',
      'commands:',
      '- /permissions tool <tool|prefix*> <inherit|allow|ask|deny>',
      '- /permissions network ...',
      '- /permissions secrets ...',
      '',
      deps.formatToolPolicySummary(),
      '',
      deps.formatNetworkTrustSummary(),
      '',
      deps.formatSecretTrustSummary(),
    ].join('\n');
  }

  if (requested === 'tools') {
    return deps.formatToolPolicySummary();
  }

  if (requested === 'network') {
    const action = args[1]?.trim().toLowerCase() ?? '';
    const value = args[2]?.trim() ?? '';
    if (!action || action === 'status') {
      return deps.formatNetworkTrustSummary();
    }
    if (action === 'allow') {
      if (!value) {
        return 'Usage: /permissions network allow <host>';
      }
      await deps.addStringListConfigValue('tools.network.allowed_hosts', value);
      return deps.formatNetworkTrustSummary();
    }
    if (action === 'deny') {
      if (!value) {
        return 'Usage: /permissions network deny <host>';
      }
      await deps.addStringListConfigValue('tools.network.denied_hosts', value);
      return deps.formatNetworkTrustSummary();
    }
    if (action === 'remove') {
      const target = args[2]?.trim().toLowerCase();
      const entry = args[3]?.trim() ?? '';
      if (target === 'allow') {
        if (!entry) {
          return 'Usage: /permissions network remove allow <host>';
        }
        await deps.removeStringListConfigValue('tools.network.allowed_hosts', entry);
        return deps.formatNetworkTrustSummary();
      }
      if (target === 'deny') {
        if (!entry) {
          return 'Usage: /permissions network remove deny <host>';
        }
        await deps.removeStringListConfigValue('tools.network.denied_hosts', entry);
        return deps.formatNetworkTrustSummary();
      }
      return 'Usage: /permissions network remove <allow|deny> <host>';
    }
    if (action === 'clear') {
      await deps.setStringListConfigValue('tools.network.allowed_hosts', []);
      await deps.setStringListConfigValue('tools.network.denied_hosts', []);
      return deps.formatNetworkTrustSummary();
    }
    if (action === 'ask-on-new-host') {
      const enabled = value.toLowerCase();
      if (!['on', 'off', 'true', 'false'].includes(enabled)) {
        return 'Usage: /permissions network ask-on-new-host <on|off>';
      }
      await setDduduConfigValue(
        process.cwd(),
        'tools.network.ask_on_new_host',
        enabled === 'on' || enabled === 'true',
      );
      await loadConfig();
      deps.scheduleStatePush();
      return deps.formatNetworkTrustSummary();
    }
    return 'Usage: /permissions network [status|allow <host>|deny <host>|remove <allow|deny> <host>|clear|ask-on-new-host <on|off>]';
  }

  if (requested === 'secrets') {
    const action = args[1]?.trim().toLowerCase() ?? '';
    const target = args[2]?.trim().toLowerCase() ?? '';
    const value = args[3]?.trim() ?? '';
    if (!action || action === 'status') {
      return deps.formatSecretTrustSummary();
    }
    if (action === 'add') {
      if (target === 'path') {
        if (!value) {
          return 'Usage: /permissions secrets add path <pattern>';
        }
        await deps.addStringListConfigValue('tools.secrets.protected_paths', value);
        return deps.formatSecretTrustSummary();
      }
      if (target === 'env') {
        if (!value) {
          return 'Usage: /permissions secrets add env <NAME>';
        }
        await deps.addStringListConfigValue('tools.secrets.protected_env', value);
        return deps.formatSecretTrustSummary();
      }
      return 'Usage: /permissions secrets add <path|env> <value>';
    }
    if (action === 'remove') {
      if (target === 'path') {
        if (!value) {
          return 'Usage: /permissions secrets remove path <pattern>';
        }
        await deps.removeStringListConfigValue('tools.secrets.protected_paths', value);
        return deps.formatSecretTrustSummary();
      }
      if (target === 'env') {
        if (!value) {
          return 'Usage: /permissions secrets remove env <NAME>';
        }
        await deps.removeStringListConfigValue('tools.secrets.protected_env', value);
        return deps.formatSecretTrustSummary();
      }
      return 'Usage: /permissions secrets remove <path|env> <value>';
    }
    return 'Usage: /permissions secrets [status|add <path|env> <value>|remove <path|env> <value>]';
  }

  if (requested === 'tool') {
    const name = args[1]?.trim();
    const policy = args[2]?.trim().toLowerCase();
    if (!name || !policy || !isToolPolicy(policy)) {
      return 'Usage: /permissions tool <tool-name|prefix*> <inherit|allow|ask|deny>';
    }
    await deps.setConfiguredToolPolicy(name, policy);
    return [`Tool policy updated: ${name} -> ${policy}`, '', deps.formatToolPolicySummary()].join('\n');
  }

  const nextProfile = requested === 'workspace' ? 'workspace-write' : requested === 'full' ? 'permissionless' : requested;
  if (!isPermissionProfile(nextProfile)) {
    return 'Usage: /permissions <plan|ask|workspace-write|permissionless>';
  }

  const changed = await deps.requestPermissionProfileChange(nextProfile, 'permissions');
  if (!changed) {
    return `Permissions unchanged: ${deps.permissionProfile}`;
  }
  return `Permissions updated: ${nextProfile}`;
};

export const runTodoCommand = async (args: string[], deps: WorkspaceCommandDeps): Promise<string> => {
  const [action, ...rest] = args;
  const trimmedAction = action?.trim().toLowerCase() ?? '';

  if (!trimmedAction) {
    return formatPlanSummary(deps);
  }

  if (trimmedAction === 'clear') {
    await deps.clearPlan();
    return 'Plan cleared.';
  }

  if (trimmedAction === 'add') {
    const step = rest.join(' ').trim();
    if (!step) {
      return 'Usage: /todo add <step>';
    }
    await deps.addPlanItem(step);
    return formatPlanSummary(deps);
  }

  if (trimmedAction === 'doing' || trimmedAction === 'done' || trimmedAction === 'pending') {
    const stepOrId = rest.join(' ').trim();
    if (!stepOrId) {
      return `Usage: /todo ${trimmedAction} <step-or-id>`;
    }
    await deps.updatePlanItem(stepOrId, {
      status: trimmedAction === 'doing' ? 'in_progress' : trimmedAction === 'done' ? 'completed' : 'pending',
    });
    return formatPlanSummary(deps);
  }

  return 'Usage: /todo [add|doing|done|pending|clear] ...';
};

export const formatArtifactSummary = (deps: WorkspaceCommandDeps): string => {
  if (deps.artifacts.length === 0) {
    return 'Artifacts: none';
  }

  return [
    'Artifacts',
    ...deps.artifacts.slice(0, 8).flatMap((artifact, index) => {
      const lines = formatArtifactForInspector(artifact as never);
      return lines.map((line, lineIndex) => (lineIndex === 0 ? `${index + 1}. ${line}` : `   ${line}`));
    }),
  ].join('\n');
};

export const runQueueCommand = async (args: string[], deps: WorkspaceCommandDeps): Promise<string> => {
  const [action, ...rest] = args;
  const command = action?.trim().toLowerCase() ?? '';

  if (!command) {
    return deps.formatQueueSummary();
  }

  if (command === 'clear') {
    deps.queuedPrompts.length = 0;
    deps.syncQueuedPrompts();
    return 'Queue cleared.';
  }

  if (command === 'drop') {
    const ref = rest[0]?.trim();
    if (!ref) {
      return 'Usage: /queue drop <index>';
    }
    const index = deps.resolveQueueIndex(ref);
    const [removed] = deps.queuedPrompts.splice(index, 1);
    deps.syncQueuedPrompts();
    return `Dropped queue item ${index + 1}: ${previewText(removed ?? '', 120)}`;
  }

  if (command === 'promote') {
    const ref = rest[0]?.trim();
    if (!ref) {
      return 'Usage: /queue promote <index>';
    }
    const index = deps.resolveQueueIndex(ref);
    const [prompt] = deps.queuedPrompts.splice(index, 1);
    if (prompt) {
      deps.queuedPrompts.unshift(prompt);
    }
    deps.syncQueuedPrompts();
    return deps.formatQueueSummary();
  }

  if (command === 'run') {
    const ref = rest[0]?.trim();
    if (!ref) {
      return 'Usage: /queue run <index>';
    }
    const index = deps.resolveQueueIndex(ref);
    const [prompt] = deps.queuedPrompts.splice(index, 1);
    deps.syncQueuedPrompts();
    if (!prompt) {
      return `Queue item not found: ${ref}`;
    }
    if (deps.state.loading && deps.abortController) {
      deps.queuedPrompts.unshift(prompt);
      deps.syncQueuedPrompts();
      return `Queue item ${ref} promoted to run next.`;
    }
    await deps.submit(prompt);
    return `Queue item ${ref} started.`;
  }

  return 'Usage: /queue [run|promote|drop|clear] ...';
};

export const runReviewSummary = async (): Promise<string> => {
  const git = new GitCheckpoint(process.cwd());
  if (!(await git.isAvailable())) {
    return 'Review unavailable: not a git repository.';
  }

  try {
    const diff = await git.getDiff();
    if (!diff.trim()) {
      return 'Review skipped: no diff available.';
    }

    const runner = new ChecksRunner(process.cwd());
    const report = await runner.runAllChecks(diff);
    return runner.formatReport(report);
  } catch (error: unknown) {
    const message = error instanceof Error && error.message.trim().length > 0 ? error.message : String(error);
    return `Review failed: ${message}`;
  }
};

export const runJobsCommand = async (args: string[], deps: WorkspaceCommandDeps): Promise<string> => {
  const [action, ...rest] = args;
  const command = action?.trim().toLowerCase() ?? '';

  if (!command) {
    return deps.formatJobsSummary();
  }

  if (command === 'cancel') {
    const ref = rest[0]?.trim();
    if (!ref) {
      return 'Usage: /jobs cancel <index-or-id>';
    }
    const job = await deps.resolveBackgroundJob(ref);
    const stored = await deps.getStoredBackgroundJob(job.id);
    if (job.status !== 'running' || !stored?.pid) {
      return `Job ${ref} is not cancellable.`;
    }
    try {
      process.kill(stored.pid, 'SIGTERM');
    } catch {
      await deps.backgroundJobStore?.update(job.id, {
        status: 'cancelled',
        detail: 'cancelled by user',
        finishedAt: Date.now(),
        pid: null,
      });
    }
    const cancelled = await deps.waitForJobCompletion(job.id, 2_000);
    await deps.pollBackgroundJobs();
    return cancelled
      ? `Cancelled job ${ref}.`
      : `Cancellation signal sent to job ${ref}; waiting for worker shutdown.`;
  }

  if (command === 'retry') {
    const ref = rest[0]?.trim();
    if (!ref) {
      return 'Usage: /jobs retry <index-or-id>';
    }
    const job = await deps.resolveBackgroundJob(ref);
    if (!deps.canStartBackgroundJob()) {
      return 'Retry unavailable: background capacity full.';
    }
    if (!job.prompt) {
      return `Job ${ref} cannot be retried.`;
    }
    if (job.kind === 'team') {
      await deps.startBackgroundTeamRun(job.strategy ?? 'parallel', job.prompt, {
        routeNote: `Team run retry · ${job.strategy ?? 'parallel'}`,
        attempt: (job.attempt ?? 0) + 1,
      });
    } else {
      await deps.startBackgroundDelegatedRoute(
        {
          id: randomUUID(),
          role: 'user',
          content: job.prompt,
          timestamp: Date.now(),
        },
        {
          kind: 'delegate',
          purpose: job.purpose && job.purpose !== 'general' ? job.purpose : 'general',
          preferredMode: job.preferredMode ?? undefined,
          reason: 'manual retry',
          repairAttempt: (job.attempt ?? 0) + 1,
        },
      );
    }
    return `Retried job ${ref} in background.`;
  }

  if (command === 'inspect') {
    const ref = rest[0]?.trim();
    if (!ref) {
      return 'Usage: /jobs inspect <index-or-id>';
    }
    const job = await deps.resolveBackgroundJob(ref);
    const stored = await deps.getStoredBackgroundJob(job.id);
    if (stored) {
      return [
        `Job ${stored.id}`,
        `label: ${stored.label}`,
        `kind: ${stored.kind}`,
        `status: ${stored.status}`,
        stored.purpose ? `purpose: ${stored.purpose}` : null,
        stored.preferredMode ? `mode: ${HARNESS_MODES[stored.preferredMode].label}` : null,
        stored.strategy ? `strategy: ${stored.strategy}` : null,
        stored.reason ? `reason: ${stored.reason}` : null,
        stored.attempt > 0 ? `attempt: ${stored.attempt}` : null,
        `created: ${new Date(stored.createdAt).toISOString()}`,
        stored.startedAt ? `started: ${new Date(stored.startedAt).toISOString()}` : null,
        stored.finishedAt ? `finished: ${new Date(stored.finishedAt).toISOString()}` : null,
        `updated: ${new Date(stored.updatedAt).toISOString()}`,
        stored.detail ? `detail: ${stored.detail}` : null,
        stored.result?.workspacePath ? `workspace: ${stored.result.workspacePath}` : null,
        stored.result?.workspaceApply
          ? `apply: ${stored.result.workspaceApply.applied ? 'applied' : stored.result.workspaceApply.empty ? 'empty' : 'failed'} · ${stored.result.workspaceApply.summary}${stored.result.workspaceApply.error ? ` · ${stored.result.workspaceApply.error}` : ''}`
          : null,
        stored.result?.text ? `result: ${previewText(stored.result.text, 220)}` : null,
        stored.result?.verification?.summary ? `verification: ${stored.result.verification.summary}` : null,
        stored.artifact ? `artifact: ${stored.artifact.title}` : null,
        stored.prompt ? `prompt: ${stored.prompt}` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n');
    }
    return deps.formatJobInspect(job);
  }

  if (command === 'logs') {
    const ref = rest[0]?.trim();
    if (!ref) {
      return 'Usage: /jobs logs <index-or-id>';
    }
    const job = await deps.resolveBackgroundJob(ref);
    const stored = await deps.getStoredBackgroundJob(job.id);
    if (!stored) {
      return `Job ${ref} has no stored logs.`;
    }
    return formatJobLogs(stored);
  }

  if (command === 'result') {
    const ref = rest[0]?.trim();
    if (!ref) {
      return 'Usage: /jobs result <index-or-id>';
    }
    const job = await deps.resolveBackgroundJob(ref);
    const stored = await deps.getStoredBackgroundJob(job.id);
    if (stored?.result?.text) {
      return stored.result.text;
    }
    if (stored?.artifact) {
      return [
        stored.artifact.title,
        `source: ${stored.artifact.source}`,
        stored.artifact.mode ? `mode: ${HARNESS_MODES[stored.artifact.mode].label}` : null,
        `created: ${stored.artifact.createdAt}`,
        '',
        stored.artifact.summary,
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n');
    }
    return deps.formatJobResult(job);
  }

  if (command === 'promote') {
    const ref = rest[0]?.trim();
    if (!ref) {
      return 'Usage: /jobs promote <index-or-id>';
    }
    const job = await deps.resolveBackgroundJob(ref);
    if (!job.prompt) {
      return `Job ${ref} cannot be promoted.`;
    }

    if (job.status === 'running' && job.controller) {
      job.controller.abort();
    } else {
      const stored = await deps.getStoredBackgroundJob(job.id);
      if (stored?.pid) {
        try {
          process.kill(stored.pid, 'SIGTERM');
        } catch {
        }
        await deps.backgroundJobStore?.update(job.id, {
          status: 'error',
          detail: 'promoted to foreground',
          finishedAt: Date.now(),
          pid: null,
        });
        await deps.pollBackgroundJobs();
      }
    }

    if (deps.state.loading && deps.abortController) {
      return 'Promote unavailable while a foreground request is active.';
    }

    if (job.kind === 'team') {
      await deps.executeTeamRun(job.strategy ?? 'parallel', job.prompt, {
        routeNote: `Team run promoted · ${job.strategy ?? 'parallel'}`,
      });
    } else {
      await deps.submit(job.prompt);
    }
    return `Promoted job ${ref} to foreground.`;
  }

  return 'Usage: /jobs [cancel|retry|inspect|logs|result|promote] ...';
};

export const runCheckpointCommand = async (message: string, deps: WorkspaceCommandDeps): Promise<string> => {
  if (!deps.config?.git_checkpoint) {
    return 'Checkpointing disabled in config.';
  }

  const git = new GitCheckpoint(process.cwd());
  if (!(await git.isAvailable())) {
    return 'Checkpoint unavailable: not a git repository.';
  }

  const hash = await git.checkpoint(message || 'checkpoint');
  return hash ? `Checkpoint created: ${hash.slice(0, 8)}` : 'Checkpoint skipped: no changes to commit.';
};

export const runUndoCommand = async (): Promise<string> => {
  const git = new GitCheckpoint(process.cwd());
  if (!(await git.isAvailable())) {
    return 'Undo unavailable: not a git repository.';
  }

  const success = await git.undo();
  return success ? 'Reverted last ddudu checkpoint.' : 'No ddudu checkpoint to undo.';
};
