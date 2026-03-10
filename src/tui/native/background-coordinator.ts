import {
  BackgroundJobStore,
  type BackgroundJobAgentActivity,
  type BackgroundJobChecklistItem,
  type BackgroundJobRecord,
  type BackgroundJobStatus,
} from '../../core/background-jobs.js';
import type { DelegationPurpose } from '../../core/delegation.js';
import type { NamedMode } from '../../core/types.js';

export interface BackgroundUiJobState {
  id: string;
  kind: 'delegate' | 'team';
  label: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  detail: string | null;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number | null;
  prompt?: string;
  purpose?: DelegationPurpose | 'general';
  preferredMode?: NamedMode | null;
  strategy?: 'parallel' | 'sequential' | 'delegate';
  reason?: string | null;
  artifactId?: string | null;
  artifactTitle?: string | null;
  verificationSummary?: string | null;
  attempt?: number;
  hasResult?: boolean;
  resultPreview?: string | null;
  workspacePath?: string | null;
  checklist: BackgroundJobChecklistItem[];
  controller?: AbortController | null;
}

export interface DetachedAgentActivityState {
  id: string;
  label: string;
  mode: NamedMode | null;
  purpose: string | null;
  checklistId?: string | null;
  status: 'queued' | 'running' | 'verifying' | 'done' | 'error';
  detail: string | null;
  workspacePath: string | null;
  updatedAt: number;
}

interface BackgroundCoordinatorConfig {
  previewText: (value: string, maxLength?: number) => string;
  formatChecklistLinkedDetail: (
    checklist: BackgroundJobChecklistItem[],
    checklistId: string | null | undefined,
    detail: string | null | undefined,
  ) => string | null;
}

export class BackgroundCoordinator {
  private store: BackgroundJobStore | null = null;
  private readonly statusCache = new Map<string, BackgroundJobStatus | 'running'>();
  private readonly config: BackgroundCoordinatorConfig;

  public constructor(config: BackgroundCoordinatorConfig) {
    this.config = config;
  }

  public setStore(store: BackgroundJobStore | null): void {
    this.store = store;
  }

  public clearStatusCache(): void {
    this.statusCache.clear();
  }

  public hasLiveBackgroundWork(input: {
    foregroundLoading: boolean;
    jobs: Array<{ status: BackgroundUiJobState['status'] }>;
    agentActivities: Array<{ status: DetachedAgentActivityState['status'] }>;
  }): boolean {
    return (
      input.foregroundLoading ||
      input.jobs.some((job) => job.status === 'running') ||
      input.agentActivities.some(
        (activity) =>
          activity.status === 'running' ||
          activity.status === 'verifying' ||
          activity.status === 'queued',
      )
    );
  }

  public mapStoredJobToState(job: BackgroundJobRecord): BackgroundUiJobState {
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status === 'queued' ? 'running' : job.status,
      detail: job.detail,
      startedAt: job.startedAt ?? job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt ?? null,
      prompt: job.prompt,
      purpose: job.purpose,
      preferredMode: job.preferredMode ?? null,
      strategy: job.strategy,
      reason: job.reason ?? null,
      artifactId: job.artifact?.id ?? null,
      artifactTitle: job.artifact?.title ?? null,
      verificationSummary: job.result?.verification?.summary ?? null,
      attempt: job.attempt ?? 0,
      hasResult: Boolean(job.result?.text || job.artifact),
      resultPreview: job.result?.text ? this.config.previewText(job.result.text, 160) : job.artifact?.summary ?? null,
      workspacePath: job.result?.workspacePath ?? null,
      checklist: job.checklist.map((item) => ({ ...item })),
      controller: null,
    };
  }

  public collectDetachedAgentActivities(jobs: BackgroundJobRecord[]): DetachedAgentActivityState[] {
    return jobs.flatMap((job) =>
      job.agentActivities.map((activity: BackgroundJobAgentActivity) => ({
        id: activity.id,
        label: activity.label,
        mode: activity.mode,
        purpose: activity.purpose,
        checklistId: activity.checklistId ?? null,
        status: activity.status,
        detail: this.config.formatChecklistLinkedDetail(job.checklist, activity.checklistId, activity.detail),
        workspacePath: activity.workspacePath,
        updatedAt: activity.updatedAt,
      })),
    );
  }

  public async pollSession(sessionId: string): Promise<{
    jobs: BackgroundUiJobState[];
    detachedActivities: DetachedAgentActivityState[];
    transitioned: BackgroundJobRecord[];
  }> {
    if (!this.store || !sessionId) {
      return {
        jobs: [],
        detachedActivities: [],
        transitioned: [],
      };
    }

    const jobs = await this.store.listBySession(sessionId);
    const transitioned: BackgroundJobRecord[] = [];

    for (const job of jobs) {
      const previous = this.statusCache.get(job.id);
      const nextStatus = job.status === 'queued' ? 'running' : job.status;
      this.statusCache.set(job.id, nextStatus);

      if (previous === 'running' && (job.status === 'done' || job.status === 'error' || job.status === 'cancelled')) {
        transitioned.push(job);
      }
    }

    return {
      jobs: jobs.map((job) => this.mapStoredJobToState(job)),
      detachedActivities: this.collectDetachedAgentActivities(jobs),
      transitioned,
    };
  }
}
