import type { NamedMode } from './types.js';
import type { DelegationPurpose } from './delegation.js';

export type PlanItemStatus = 'pending' | 'in_progress' | 'completed';
export type PermissionProfile = 'plan' | 'ask' | 'workspace-write' | 'permissionless';
export type WorkflowArtifactKind = 'answer' | 'plan' | 'review' | 'design' | 'patch' | 'briefing' | 'research';

export interface PlanItem {
  id: string;
  step: string;
  status: PlanItemStatus;
  owner?: string;
  updatedAt: string;
}

export interface WorkflowRemoteSession {
  provider: string;
  sessionId: string;
  syncedMessageCount: number;
  lastModel: string;
  lastUsedAt: number;
}

export interface WorkflowArtifact {
  id: string;
  kind: WorkflowArtifactKind;
  title: string;
  summary: string;
  source: 'delegate' | 'team' | 'session';
  mode?: NamedMode;
  createdAt: string;
}

export interface WorkflowBackgroundJobSnapshot {
  id: string;
  kind: 'delegate' | 'team';
  label: string;
  status: 'running' | 'done' | 'error';
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
  checklist?: {
    id: string;
    label: string;
    owner: string | null;
    status: 'pending' | 'in_progress' | 'completed' | 'error';
    detail: string | null;
    updatedAt: number;
  }[];
}

export interface WorkflowStateSnapshot {
  mode: NamedMode;
  selectedModels: Record<NamedMode, string>;
  permissionProfile: PermissionProfile;
  todos: PlanItem[];
  remoteSessions: WorkflowRemoteSession[];
  artifacts: WorkflowArtifact[];
  queuedPrompts: string[];
  backgroundJobs: WorkflowBackgroundJobSnapshot[];
}
