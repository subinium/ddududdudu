import type { DelegationRuntime } from '../core/delegation.js';
import type { NamedMode } from '../core/types.js';
import type { PermissionProfile, PlanItem, PlanItemStatus } from '../core/workflow-state.js';

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
}

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
  onProgress?: (text: string) => void;
  onAgentActivity?: (activity: {
    id: string;
    label: string;
    status: 'queued' | 'running' | 'verifying' | 'done' | 'error';
    mode?: NamedMode;
    purpose?: string;
    detail?: string;
    workspacePath?: string;
  }) => void;
  contextSnapshot?: (prompt: string, purpose?: string) => Promise<string>;
  askUser?: (question: string, options?: string[]) => Promise<string>;
  authToken?: string;
  authBaseUrl?: string;
  delegation?: DelegationRuntime;
  sessionId?: string;
  currentMode?: NamedMode;
  permissionProfile?: PermissionProfile;
  setPermissionProfile?: (profile: PermissionProfile) => Promise<void> | void;
  plan?: {
    list: () => PlanItem[];
    replace: (items: PlanItem[]) => Promise<void> | void;
    add: (step: string, status?: PlanItemStatus, owner?: string) => Promise<void> | void;
    update: (
      stepOrId: string,
      updates: { status?: PlanItemStatus; owner?: string },
    ) => Promise<void> | void;
    clear: () => Promise<void> | void;
  };
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export * from './registry.js';
export * from './file-tools.js';
export * from './bash-tool.js';
export * from './search-tools.js';
export * from './context-tools.js';
export * from './web-tool.js';
export * from './task-tool.js';
export * from './oracle-tool.js';
export * from './toolbox.js';
export * from './ask-question-tool.js';
export * from './update-plan-tool.js';
