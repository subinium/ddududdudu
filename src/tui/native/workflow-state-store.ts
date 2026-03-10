import { randomUUID } from 'node:crypto';

import { SessionManager } from '../../core/session.js';
import type { LoadedSession, NamedMode, SessionEntry } from '../../core/types.js';
import type { NativeMessageState } from './protocol.js';
import { WORKFLOW_STATE_VERSION, type PermissionProfile, type PlanItem, type PlanItemStatus, type WorkflowArtifact, type WorkflowBackgroundJobSnapshot, type WorkflowRemoteSession, type WorkflowStateSnapshot, type WorkflowArtifactKind } from '../../core/workflow-state.js';
import { findModeForProviderModel, parseNamedMode, readSessionHeaderMode } from './controller-support.js';

export interface WorkflowStateSource {
  currentMode: NamedMode;
  selectedModels: Record<NamedMode, string>;
  permissionProfile: PermissionProfile;
  todos: PlanItem[];
  remoteSessions: Iterable<WorkflowRemoteSession>;
  artifacts: WorkflowArtifact[];
  queuedPrompts: string[];
  backgroundJobs: ReadonlyArray<WorkflowBackgroundJobSnapshot & { controller?: unknown }>;
}

export interface WorkflowParseContext {
  fallbackMode: NamedMode;
  fallbackSelectedModels: Record<NamedMode, string>;
  fallbackPermissionProfile: PermissionProfile;
  normalizePermissionProfile: (value: unknown) => PermissionProfile;
}

export interface RestoredWorkflowSession {
  sessionId: string;
  mode: NamedMode;
  messages: NativeMessageState[];
  selectedModels: Record<NamedMode, string>;
  permissionProfile: PermissionProfile;
  todos: PlanItem[];
  remoteSessions: WorkflowRemoteSession[];
  artifacts: WorkflowArtifact[];
  queuedPrompts: string[];
  backgroundJobs: WorkflowBackgroundJobSnapshot[];
}

const isPlanStatus = (value: unknown): value is PlanItemStatus =>
  value === 'pending' || value === 'in_progress' || value === 'completed';

const isArtifactKind = (value: unknown): value is WorkflowArtifactKind =>
  value === 'answer'
    || value === 'plan'
    || value === 'review'
    || value === 'design'
    || value === 'patch'
    || value === 'briefing'
    || value === 'research';

const getEntryString = (entry: SessionEntry, key: string): string => {
  const value = entry.data[key];
  return typeof value === 'string' ? value : '';
};

const clonePlanItems = (items: PlanItem[]): PlanItem[] =>
  items.map((item) => ({ ...item }));

const cloneArtifacts = (artifacts: WorkflowArtifact[]): WorkflowArtifact[] =>
  artifacts.map((artifact) => ({ ...artifact }));

const cloneRemoteSessions = (sessions: Iterable<WorkflowRemoteSession>): WorkflowRemoteSession[] =>
  Array.from(sessions, (session) => ({ ...session }));

const cloneBackgroundJobs = (
  jobs: ReadonlyArray<WorkflowBackgroundJobSnapshot & { controller?: unknown }>,
): WorkflowBackgroundJobSnapshot[] =>
  jobs.map((job) => ({
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    detail: job.detail,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt ?? null,
    prompt: job.prompt,
    purpose: job.purpose,
    preferredMode: job.preferredMode ?? null,
    strategy: job.strategy,
    reason: job.reason ?? null,
    artifactId: job.artifactId ?? null,
    artifactTitle: job.artifactTitle ?? null,
    verificationSummary: job.verificationSummary ?? null,
    attempt: job.attempt ?? 0,
    hasResult: job.hasResult ?? false,
    resultPreview: job.resultPreview ?? null,
    workspacePath: job.workspacePath ?? null,
    checklist: job.checklist.map((item) => ({ ...item })),
  }));

export class WorkflowStateStore {
  private sessionManager: SessionManager | null;

  public constructor(sessionManager: SessionManager | null = null) {
    this.sessionManager = sessionManager;
  }

  public setSessionManager(sessionManager: SessionManager | null): void {
    this.sessionManager = sessionManager;
  }

  public buildSnapshot(source: WorkflowStateSource): WorkflowStateSnapshot {
    return {
      version: WORKFLOW_STATE_VERSION,
      mode: source.currentMode,
      selectedModels: { ...source.selectedModels },
      permissionProfile: source.permissionProfile,
      todos: clonePlanItems(source.todos),
      remoteSessions: cloneRemoteSessions(source.remoteSessions),
      artifacts: cloneArtifacts(source.artifacts),
      queuedPrompts: [...source.queuedPrompts],
      backgroundJobs: cloneBackgroundJobs(source.backgroundJobs),
    };
  }

  public async persist(
    reason: string,
    sessionId: string,
    sourceOrSnapshot: WorkflowStateSource | WorkflowStateSnapshot,
  ): Promise<void> {
    if (!this.sessionManager || !sessionId) {
      return;
    }

    const snapshot =
      'version' in sourceOrSnapshot
        ? sourceOrSnapshot
        : this.buildSnapshot(sourceOrSnapshot);

    await this.sessionManager.append(sessionId, {
      type: 'message',
      timestamp: new Date().toISOString(),
      data: {
        kind: 'controller_state',
        reason,
        controllerState: snapshot,
      },
    });
  }

  public async seedSessionMessages(
    sessionId: string,
    messages: NativeMessageState[],
    mode: NamedMode,
  ): Promise<void> {
    if (!this.sessionManager) {
      return;
    }

    for (const message of messages) {
      const data: Record<string, unknown> = { mode };
      if (message.role === 'user') {
        data.user = message.content;
      } else if (message.role === 'assistant') {
        data.assistant = message.content;
      } else if (message.role === 'system') {
        data.system = message.content;
      } else {
        continue;
      }

      await this.sessionManager.append(sessionId, {
        type: 'message',
        timestamp: new Date(message.timestamp).toISOString(),
        data,
      });
    }
  }

  public parseSnapshot(entry: SessionEntry, context: WorkflowParseContext): WorkflowStateSnapshot | null {
    const snapshot = entry.data.controllerState;
    if (typeof snapshot !== 'object' || snapshot === null) {
      return null;
    }

    const record = snapshot as Record<string, unknown>;
    const version =
      typeof record.version === 'number' && Number.isFinite(record.version)
        ? record.version
        : WORKFLOW_STATE_VERSION;
    const mode = parseNamedMode(record.mode) ?? context.fallbackMode;
    const permissionProfile = context.normalizePermissionProfile(record.permissionProfile);
    const selectedModelsRecord =
      typeof record.selectedModels === 'object' && record.selectedModels !== null
        ? (record.selectedModels as Record<string, unknown>)
        : {};
    const selectedModels: Record<NamedMode, string> = {
      jennie: typeof selectedModelsRecord.jennie === 'string' ? selectedModelsRecord.jennie : context.fallbackSelectedModels.jennie,
      lisa: typeof selectedModelsRecord.lisa === 'string' ? selectedModelsRecord.lisa : context.fallbackSelectedModels.lisa,
      'rosé': typeof selectedModelsRecord['rosé'] === 'string' ? selectedModelsRecord['rosé'] : context.fallbackSelectedModels['rosé'],
      jisoo: typeof selectedModelsRecord.jisoo === 'string' ? selectedModelsRecord.jisoo : context.fallbackSelectedModels.jisoo,
    };
    const todos = Array.isArray(record.todos)
      ? record.todos
          .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          .map((item) => ({
            id: typeof item.id === 'string' && item.id.trim() ? item.id : randomUUID(),
            step: typeof item.step === 'string' ? item.step.trim() : '',
            status: isPlanStatus(item.status) ? item.status : 'pending',
            owner: typeof item.owner === 'string' && item.owner.trim() ? item.owner.trim() : undefined,
            updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : entry.timestamp,
          }))
          .filter((item) => item.step.length > 0)
      : [];
    const remoteSessions = Array.isArray(record.remoteSessions)
      ? record.remoteSessions
          .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          .map((item) => ({
            provider: typeof item.provider === 'string' ? item.provider : '',
            sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
            syncedMessageCount: typeof item.syncedMessageCount === 'number' ? item.syncedMessageCount : 0,
            lastModel: typeof item.lastModel === 'string' ? item.lastModel : '',
            lastUsedAt: typeof item.lastUsedAt === 'number' ? item.lastUsedAt : Date.parse(entry.timestamp),
          }))
          .filter((item) => item.provider && item.sessionId)
      : [];
    const artifacts = Array.isArray(record.artifacts)
      ? record.artifacts
          .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          .map((item) => ({
            id: typeof item.id === 'string' && item.id.trim() ? item.id : randomUUID(),
            kind: isArtifactKind(item.kind) ? item.kind : 'answer',
            title: typeof item.title === 'string' ? item.title.trim() : '',
            summary: typeof item.summary === 'string' ? item.summary.trim() : '',
            payload:
              typeof item.payload === 'object' && item.payload !== null
                ? (item.payload as WorkflowArtifact['payload'])
                : undefined,
            source:
              item.source === 'delegate' || item.source === 'team' || item.source === 'session'
                ? item.source
                : 'session',
            mode: parseNamedMode(item.mode) ?? undefined,
            createdAt: typeof item.createdAt === 'string' ? item.createdAt : entry.timestamp,
          }))
          .filter((item) => item.title.length > 0 && item.summary.length > 0)
      : [];
    const queuedPrompts = Array.isArray(record.queuedPrompts)
      ? record.queuedPrompts
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [];
    const backgroundJobs = Array.isArray(record.backgroundJobs)
      ? record.backgroundJobs
          .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
          .map((item): WorkflowBackgroundJobSnapshot | null => {
            const status =
              item.status === 'running' ||
              item.status === 'done' ||
              item.status === 'error' ||
              item.status === 'cancelled'
                ? item.status
                : null;
            const kind = item.kind === 'delegate' || item.kind === 'team' ? item.kind : null;
            if (!status || !kind) {
              return null;
            }

            return {
              id: typeof item.id === 'string' && item.id.trim() ? item.id : randomUUID(),
              kind,
              label: typeof item.label === 'string' && item.label.trim() ? item.label.trim() : kind,
              status,
              detail: typeof item.detail === 'string' ? item.detail : null,
              startedAt: typeof item.startedAt === 'number' ? item.startedAt : Date.parse(entry.timestamp),
              updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.parse(entry.timestamp),
              finishedAt: typeof item.finishedAt === 'number' ? item.finishedAt : null,
              prompt: typeof item.prompt === 'string' && item.prompt.trim() ? item.prompt.trim() : undefined,
              purpose:
                item.purpose === 'general' ||
                item.purpose === 'execution' ||
                item.purpose === 'planning' ||
                item.purpose === 'research' ||
                item.purpose === 'review' ||
                item.purpose === 'design' ||
                item.purpose === 'oracle'
                  ? item.purpose
                  : undefined,
              preferredMode: parseNamedMode(item.preferredMode),
              strategy:
                item.strategy === 'parallel' || item.strategy === 'sequential' || item.strategy === 'delegate'
                  ? item.strategy
                  : undefined,
              reason: typeof item.reason === 'string' ? item.reason : null,
              artifactId: typeof item.artifactId === 'string' && item.artifactId.trim() ? item.artifactId.trim() : null,
              artifactTitle:
                typeof item.artifactTitle === 'string' && item.artifactTitle.trim()
                  ? item.artifactTitle.trim()
                  : null,
              verificationSummary:
                typeof item.verificationSummary === 'string' && item.verificationSummary.trim()
                  ? item.verificationSummary.trim()
                  : null,
              attempt: typeof item.attempt === 'number' && Number.isFinite(item.attempt) ? item.attempt : 0,
              hasResult: item.hasResult === true,
              resultPreview:
                typeof item.resultPreview === 'string' && item.resultPreview.trim()
                  ? item.resultPreview.trim()
                  : null,
              workspacePath:
                typeof item.workspacePath === 'string' && item.workspacePath.trim()
                  ? item.workspacePath.trim()
                  : null,
              checklist: Array.isArray(item.checklist)
                ? item.checklist
                    .filter((part): part is Record<string, unknown> => typeof part === 'object' && part !== null)
                    .map((part) => ({
                      id: typeof part.id === 'string' && part.id.trim() ? part.id.trim() : randomUUID(),
                      label: typeof part.label === 'string' && part.label.trim() ? part.label.trim() : 'step',
                      owner: typeof part.owner === 'string' && part.owner.trim() ? part.owner.trim() : null,
                      status:
                        part.status === 'pending' ||
                        part.status === 'blocked' ||
                        part.status === 'in_progress' ||
                        part.status === 'completed' ||
                        part.status === 'error'
                          ? part.status
                          : 'pending',
                      detail: typeof part.detail === 'string' && part.detail.trim() ? part.detail.trim() : null,
                      dependsOn: Array.isArray(part.dependsOn)
                        ? part.dependsOn.filter(
                            (dependency): dependency is string =>
                              typeof dependency === 'string' && dependency.trim().length > 0,
                          )
                        : undefined,
                      handoffTo:
                        typeof part.handoffTo === 'string' && part.handoffTo.trim()
                          ? part.handoffTo.trim()
                          : null,
                      updatedAt:
                        typeof part.updatedAt === 'number' && Number.isFinite(part.updatedAt)
                          ? part.updatedAt
                          : Date.parse(entry.timestamp),
                    }))
                : [],
            };
          })
          .filter((item): item is WorkflowBackgroundJobSnapshot => item !== null)
      : [];

    return {
      version,
      mode,
      selectedModels,
      permissionProfile,
      todos,
      remoteSessions,
      artifacts,
      queuedPrompts,
      backgroundJobs,
    };
  }

  public restoreSession(
    session: LoadedSession,
    context: WorkflowParseContext,
  ): RestoredWorkflowSession {
    let restoredMessages: NativeMessageState[] = [];
    let restoredMode: NamedMode | null = null;
    let restoredSnapshot: WorkflowStateSnapshot | null = null;

    for (const entry of session.entries) {
      const timestamp = Date.parse(entry.timestamp);
      const baseTimestamp = Number.isNaN(timestamp) ? Date.now() : timestamp;

      if (entry.type === 'compaction') {
        const summary = getEntryString(entry, 'summary');
        if (!summary) {
          continue;
        }

        restoredMessages = [
          {
            id: randomUUID(),
            role: 'user',
            content: summary,
            timestamp: baseTimestamp,
          },
          {
            id: randomUUID(),
            role: 'assistant',
            content: 'Context compacted. Ready to continue.',
            timestamp: baseTimestamp + 1,
          },
        ];
        continue;
      }

      if (entry.type !== 'message') {
        continue;
      }

      const snapshot = this.parseSnapshot(entry, context);
      if (snapshot) {
        restoredSnapshot = snapshot;
        continue;
      }

      const user = getEntryString(entry, 'user');
      const assistant = getEntryString(entry, 'assistant');
      const system = getEntryString(entry, 'system');
      const mode = getEntryString(entry, 'mode');
      const entryMode = parseNamedMode(mode);

      if (entryMode) {
        restoredMode = entryMode;
      }

      if (user) {
        restoredMessages.push({
          id: randomUUID(),
          role: 'user',
          content: user,
          timestamp: baseTimestamp,
        });
      }

      if (assistant) {
        restoredMessages.push({
          id: randomUUID(),
          role: 'assistant',
          content: assistant,
          timestamp: baseTimestamp + 1,
        });
      }

      if (system) {
        restoredMessages.push({
          id: randomUUID(),
          role: 'system',
          content: system,
          timestamp: baseTimestamp + 2,
        });
      }
    }

    const headerMode = readSessionHeaderMode(session.header.metadata);
    const mode =
      restoredSnapshot?.mode ??
      restoredMode ??
      headerMode ??
      findModeForProviderModel(session.header.provider, session.header.model) ??
      context.fallbackMode;

    const selectedModels = restoredSnapshot
      ? { ...restoredSnapshot.selectedModels }
      : { ...context.fallbackSelectedModels };
    if (session.header.model && !restoredSnapshot) {
      selectedModels[mode] = session.header.model;
    }

    return {
      sessionId: session.header.id,
      mode,
      messages: restoredMessages,
      selectedModels,
      permissionProfile: restoredSnapshot?.permissionProfile ?? context.fallbackPermissionProfile,
      todos: restoredSnapshot ? clonePlanItems(restoredSnapshot.todos) : [],
      remoteSessions: restoredSnapshot ? cloneRemoteSessions(restoredSnapshot.remoteSessions) : [],
      artifacts: restoredSnapshot ? cloneArtifacts(restoredSnapshot.artifacts) : [],
      queuedPrompts: restoredSnapshot ? [...restoredSnapshot.queuedPrompts] : [],
      backgroundJobs: restoredSnapshot ? cloneBackgroundJobs(restoredSnapshot.backgroundJobs) : [],
    };
  }
}
