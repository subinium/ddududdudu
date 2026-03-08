import type { NamedMode } from './types.js';

export type PlanItemStatus = 'pending' | 'in_progress' | 'completed';
export type PermissionProfile = 'plan' | 'ask' | 'workspace-write' | 'permissionless';

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

export interface WorkflowStateSnapshot {
  mode: NamedMode;
  selectedModels: Record<NamedMode, string>;
  permissionProfile: PermissionProfile;
  todos: PlanItem[];
  remoteSessions: WorkflowRemoteSession[];
}

