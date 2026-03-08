import type { NamedMode } from '../../core/types.js';
import type {
  PermissionProfile,
  PlanItem,
  PlanItemStatus,
  WorkflowArtifact,
  WorkflowArtifactKind,
} from '../../core/workflow-state.js';

export type NativeMessageRole = 'user' | 'assistant' | 'system' | 'tool';
export type NativeToolStatus = 'pending' | 'running' | 'done' | 'error';

export interface NativeSlashCommand {
  label: string;
  description: string;
  value: string;
}

export interface NativeToolCallState {
  id: string;
  name: string;
  args: string;
  summary: string;
  result?: string;
  status: NativeToolStatus;
}

export interface NativeMessageState {
  id: string;
  role: NativeMessageRole;
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  toolCalls?: NativeToolCallState[];
}

export interface NativeModeState {
  name: NamedMode;
  label: string;
  tagline: string;
  provider: string;
  model: string;
  active: boolean;
}

export interface NativeProviderState {
  name: string;
  available: boolean;
  source?: string;
  tokenType?: string;
}

export interface NativeMcpState {
  configuredServers: number;
  connectedServers: number;
  toolCount: number;
  serverNames: string[];
  connectedNames: string[];
}

export interface NativeLspState {
  availableServers: number;
  connectedServers: number;
  serverLabels: string[];
  connectedLabels: string[];
}

export interface NativeAskUserState {
  question: string;
  options: string[];
}

export interface NativePlanItemState extends Omit<PlanItem, 'status'> {
  status: PlanItemStatus;
}

export interface NativeAgentActivityState {
  id: string;
  label: string;
  mode: NamedMode | null;
  purpose: string | null;
  status: 'queued' | 'running' | 'verifying' | 'done' | 'error';
  detail: string | null;
  workspacePath: string | null;
  updatedAt: number;
}

export interface NativeBackgroundJobState {
  id: string;
  kind: 'delegate' | 'team';
  label: string;
  status: 'running' | 'done' | 'error';
  detail: string | null;
  startedAt: number;
  updatedAt: number;
  purpose?: string | null;
  preferredMode?: NamedMode | null;
  strategy?: 'parallel' | 'sequential' | 'delegate' | null;
  promptPreview?: string | null;
}

export interface NativeArtifactState extends Omit<WorkflowArtifact, 'kind'> {
  kind: WorkflowArtifactKind;
}

export interface NativeWorkspaceState {
  label: string;
  path: string;
  kind: string;
}

export interface NativeVerificationState {
  status: 'running' | 'passed' | 'failed' | 'skipped';
  summary: string | null;
  cwd: string | null;
}

export interface NativeRequestEstimateState {
  system: number;
  history: number;
  tools: number;
  prompt: number;
  total: number;
  mode: 'full' | 'resume' | 'hydrate';
  note: string | null;
}

export interface NativeTuiState {
  ready: boolean;
  version: string;
  cwd: string;
  mode: NamedMode;
  modes: NativeModeState[];
  provider: string;
  model: string;
  models: string[];
  authType: string | null;
  authSource: string | null;
  permissionProfile: PermissionProfile;
  loading: boolean;
  loadingLabel: string;
  loadingSince: number | null;
  playingWithFire: boolean;
  contextPercent: number;
  contextTokens: number;
  contextLimit: number;
  requestEstimate: NativeRequestEstimateState | null;
  queuedPrompts: string[];
  providers: NativeProviderState[];
  mcp: NativeMcpState | null;
  lsp: NativeLspState | null;
  messages: NativeMessageState[];
  askUser: NativeAskUserState | null;
  slashCommands: NativeSlashCommand[];
  sessionId: string | null;
  remoteSessionId: string | null;
  remoteSessionCount: number;
  teamRunStrategy: 'parallel' | 'sequential' | 'delegate' | null;
  teamRunTask: string | null;
  teamRunSince: number | null;
  todos: NativePlanItemState[];
  agentActivities: NativeAgentActivityState[];
  backgroundJobs: NativeBackgroundJobState[];
  artifacts: NativeArtifactState[];
  workspace: NativeWorkspaceState | null;
  verification: NativeVerificationState | null;
  error: string | null;
}

export type NativeBridgeEvent =
  | { type: 'state'; state: NativeTuiState }
  | { type: 'fatal'; message: string };

export type NativeBridgeCommand =
  | { type: 'submit'; content: string }
  | { type: 'abort' }
  | { type: 'clear_messages' }
  | { type: 'run_slash'; command: string }
  | { type: 'set_mode'; mode: NamedMode }
  | { type: 'cycle_mode'; direction?: 1 | -1 }
  | { type: 'set_model'; model: string }
  | { type: 'toggle_fire' }
  | { type: 'answer_ask_user'; answer: string }
  | { type: 'append_system'; content: string };
