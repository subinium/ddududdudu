import type { NamedMode } from './types.js';

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

export interface WorkflowStateSnapshot {
  mode: NamedMode;
  selectedModels: Record<NamedMode, string>;
  permissionProfile: PermissionProfile;
  todos: PlanItem[];
  remoteSessions: WorkflowRemoteSession[];
  artifacts: WorkflowArtifact[];
}
