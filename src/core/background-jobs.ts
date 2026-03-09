import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { DelegationPurpose } from './delegation.js';
import type { AgentRole } from './team-agent.js';
import type { NamedMode } from './types.js';
import type { VerificationMode, VerificationSummary } from './verifier.js';
import type { WorkflowArtifact } from './workflow-state.js';

export type BackgroundJobKind = 'delegate' | 'team';
export type BackgroundJobStatus = 'queued' | 'running' | 'done' | 'error';
export type BackgroundJobChecklistStatus = 'pending' | 'blocked' | 'in_progress' | 'completed' | 'error';

export interface BackgroundJobAgentActivity {
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

export interface BackgroundJobChecklistItem {
  id: string;
  label: string;
  owner: string | null;
  status: BackgroundJobChecklistStatus;
  detail: string | null;
  dependsOn?: string[];
  handoffTo?: string | null;
  updatedAt: number;
}

export interface BackgroundJobResult {
  text: string;
  provider: string;
  model: string;
  mode?: NamedMode;
  remoteSessionId?: string | null;
  workspacePath?: string | null;
  workspaceApply?: {
    attempted: boolean;
    applied: boolean;
    empty: boolean;
    summary: string;
    error?: string;
  } | null;
  verification?: VerificationSummary | null;
  usage?: {
    input: number;
    output: number;
    uncachedInput?: number;
    cachedInput?: number;
    cacheWriteInput?: number;
  };
}

export interface BackgroundJobRecord {
  id: string;
  sessionId: string | null;
  kind: BackgroundJobKind;
  status: BackgroundJobStatus;
  label: string;
  detail: string | null;
  cwd: string;
  prompt: string;
  purpose?: DelegationPurpose | 'general';
  preferredMode?: NamedMode | null;
  preferredModel?: string | null;
  strategy?: 'parallel' | 'sequential' | 'delegate';
  reason?: string | null;
  attempt: number;
  verificationMode?: VerificationMode;
  contextSnapshot?: string | null;
  artifacts?: WorkflowArtifact[];
  teamAgents?: AgentRole[];
  teamSharedContext?: string | null;
  checklist: BackgroundJobChecklistItem[];
  agentActivities: BackgroundJobAgentActivity[];
  result: BackgroundJobResult | null;
  artifact: WorkflowArtifact | null;
  pid: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNamedMode = (value: unknown): value is NamedMode =>
  value === 'jennie' || value === 'lisa' || value === 'rosé' || value === 'jisoo';

const isAgentStatus = (value: unknown): value is BackgroundJobAgentActivity['status'] =>
  value === 'queued' || value === 'running' || value === 'verifying' || value === 'done' || value === 'error';
const isChecklistStatus = (value: unknown): value is BackgroundJobChecklistStatus =>
  value === 'pending' || value === 'blocked' || value === 'in_progress' || value === 'completed' || value === 'error';

const normalizeChecklistDependencies = (value: unknown): string[] =>
  Array.isArray(value)
    ? Array.from(
        new Set(
          value
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      )
    : [];

export const normalizeBackgroundJobChecklist = (
  checklist: BackgroundJobChecklistItem[] | undefined | null,
): BackgroundJobChecklistItem[] => {
  if (!Array.isArray(checklist) || checklist.length === 0) {
    return [];
  }

  const completed = new Set(
    checklist
      .filter((item) => item.status === 'completed')
      .map((item) => item.id),
  );

  return checklist.map((item) => {
    const dependsOn = normalizeChecklistDependencies(item.dependsOn);
    const hasPendingDependency =
      dependsOn.length > 0 && dependsOn.some((dependencyId) => !completed.has(dependencyId));
    const normalizedStatus =
      item.status === 'pending' || item.status === 'blocked'
        ? hasPendingDependency
          ? 'blocked'
          : 'pending'
        : item.status;

    return {
      ...item,
      status: normalizedStatus,
      dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
      handoffTo: typeof item.handoffTo === 'string' && item.handoffTo.trim() ? item.handoffTo : null,
    };
  });
};

const parseJob = (raw: string): BackgroundJobRecord | null => {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    return null;
  }

  const kind = parsed.kind === 'delegate' || parsed.kind === 'team' ? parsed.kind : null;
  const status =
    parsed.status === 'queued' || parsed.status === 'running' || parsed.status === 'done' || parsed.status === 'error'
      ? parsed.status
      : null;

  if (!kind || !status || typeof parsed.id !== 'string' || typeof parsed.label !== 'string') {
    return null;
  }

  const agentActivities = Array.isArray(parsed.agentActivities)
    ? parsed.agentActivities
        .filter((item): item is Record<string, unknown> => isRecord(item))
          .map((item) => ({
          id: typeof item.id === 'string' && item.id.trim() ? item.id : randomUUID(),
          label: typeof item.label === 'string' ? item.label : 'agent',
          mode: isNamedMode(item.mode) ? item.mode : null,
          purpose: typeof item.purpose === 'string' ? item.purpose : null,
          checklistId: typeof item.checklistId === 'string' ? item.checklistId : null,
          status: isAgentStatus(item.status) ? item.status : 'running',
          detail: typeof item.detail === 'string' ? item.detail : null,
          workspacePath: typeof item.workspacePath === 'string' ? item.workspacePath : null,
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
        }))
    : [];

  const checklist = Array.isArray(parsed.checklist)
    ? parsed.checklist
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          id: typeof item.id === 'string' && item.id.trim() ? item.id : randomUUID(),
          label: typeof item.label === 'string' ? item.label : 'step',
          owner: typeof item.owner === 'string' ? item.owner : null,
          status: isChecklistStatus(item.status) ? item.status : 'pending',
          detail: typeof item.detail === 'string' ? item.detail : null,
          dependsOn: normalizeChecklistDependencies(item.dependsOn),
          handoffTo: typeof item.handoffTo === 'string' ? item.handoffTo : null,
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
        }))
    : [];

  return {
    id: parsed.id,
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
    kind,
    status,
    label: parsed.label,
    detail: typeof parsed.detail === 'string' ? parsed.detail : null,
    cwd: typeof parsed.cwd === 'string' && parsed.cwd.trim() ? parsed.cwd : process.cwd(),
    prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
    purpose:
      parsed.purpose === 'general' ||
      parsed.purpose === 'execution' ||
      parsed.purpose === 'planning' ||
      parsed.purpose === 'research' ||
      parsed.purpose === 'review' ||
      parsed.purpose === 'design' ||
      parsed.purpose === 'oracle'
        ? parsed.purpose
        : undefined,
    preferredMode:
      parsed.preferredMode === 'jennie' ||
      parsed.preferredMode === 'lisa' ||
      parsed.preferredMode === 'rosé' ||
      parsed.preferredMode === 'jisoo'
        ? parsed.preferredMode
        : null,
    preferredModel: typeof parsed.preferredModel === 'string' ? parsed.preferredModel : null,
    strategy:
      parsed.strategy === 'parallel' || parsed.strategy === 'sequential' || parsed.strategy === 'delegate'
        ? parsed.strategy
        : undefined,
    reason: typeof parsed.reason === 'string' ? parsed.reason : null,
    attempt: typeof parsed.attempt === 'number' && Number.isFinite(parsed.attempt) ? parsed.attempt : 0,
    verificationMode:
      parsed.verificationMode === 'none' ||
      parsed.verificationMode === 'checks' ||
      parsed.verificationMode === 'full'
        ? parsed.verificationMode
        : undefined,
    contextSnapshot: typeof parsed.contextSnapshot === 'string' ? parsed.contextSnapshot : null,
    artifacts: Array.isArray(parsed.artifacts) ? (parsed.artifacts as WorkflowArtifact[]) : [],
    teamAgents: Array.isArray(parsed.teamAgents) ? (parsed.teamAgents as AgentRole[]) : [],
    teamSharedContext: typeof parsed.teamSharedContext === 'string' ? parsed.teamSharedContext : null,
    checklist: normalizeBackgroundJobChecklist(checklist),
    agentActivities,
    result: isRecord(parsed.result) ? (parsed.result as unknown as BackgroundJobResult) : null,
    artifact: isRecord(parsed.artifact) ? (parsed.artifact as unknown as WorkflowArtifact) : null,
    pid: typeof parsed.pid === 'number' ? parsed.pid : null,
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : null,
    finishedAt: typeof parsed.finishedAt === 'number' ? parsed.finishedAt : null,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
  };
};

export const resolveBackgroundJobDirectory = (sessionDirectory: string): string =>
  resolve(dirname(resolve(process.cwd(), sessionDirectory)), 'jobs');

export class BackgroundJobStore {
  private readonly jobDirectory: string;

  public constructor(jobDirectory: string) {
    this.jobDirectory = resolve(process.cwd(), jobDirectory);
  }

  public async create(
    input: Omit<
      BackgroundJobRecord,
      'id' | 'status' | 'detail' | 'pid' | 'createdAt' | 'startedAt' | 'finishedAt' | 'updatedAt'
    > & {
      id?: string;
      status?: BackgroundJobStatus;
      detail?: string | null;
      pid?: number | null;
      startedAt?: number | null;
      finishedAt?: number | null;
    },
  ): Promise<BackgroundJobRecord> {
    const now = Date.now();
    const record: BackgroundJobRecord = {
      ...input,
      id: input.id ?? randomUUID(),
      status: input.status ?? 'queued',
      detail: input.detail ?? null,
      pid: input.pid ?? null,
      createdAt: now,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? null,
      updatedAt: now,
    };
    record.checklist = normalizeBackgroundJobChecklist(record.checklist);
    await this.save(record);
    return record;
  }

  public async load(jobId: string): Promise<BackgroundJobRecord> {
    const raw = await readFile(this.getJobPath(jobId), 'utf8');
    const parsed = parseJob(raw);
    if (!parsed) {
      throw new Error(`Invalid background job record: ${jobId}`);
    }

    return parsed;
  }

  public async save(record: BackgroundJobRecord): Promise<void> {
    await mkdir(this.jobDirectory, { recursive: true });
    const normalized: BackgroundJobRecord = {
      ...record,
      checklist: normalizeBackgroundJobChecklist(record.checklist),
      updatedAt: Date.now(),
    };
    await writeFile(this.getJobPath(record.id), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  }

  public async update(jobId: string, patch: Partial<BackgroundJobRecord>): Promise<BackgroundJobRecord> {
    const current = await this.load(jobId);
    const next: BackgroundJobRecord = {
      ...current,
      ...patch,
      id: current.id,
    };
    await this.save(next);
    return next;
  }

  public async list(): Promise<BackgroundJobRecord[]> {
    await mkdir(this.jobDirectory, { recursive: true });
    const names = await readdir(this.jobDirectory);
    const jobs = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          try {
            const raw = await readFile(resolve(this.jobDirectory, name), 'utf8');
            return parseJob(raw);
          } catch {
            return null;
          }
        }),
    );

    return jobs
      .filter((job): job is BackgroundJobRecord => job !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public async listBySession(sessionId: string): Promise<BackgroundJobRecord[]> {
    const jobs = await this.list();
    return jobs.filter((job) => job.sessionId === sessionId);
  }

  public getJobDirectory(): string {
    return this.jobDirectory;
  }

  private getJobPath(jobId: string): string {
    return resolve(this.jobDirectory, `${jobId}.json`);
  }
}
