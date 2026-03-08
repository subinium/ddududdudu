import type { NamedMode } from '../../core/types.js';
import type { PermissionProfile, PlanItem, PlanItemStatus } from '../../core/workflow-state.js';

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

export interface NativeAskUserState {
  question: string;
  options: string[];
}

export interface NativePlanItemState extends Omit<PlanItem, 'status'> {
  status: PlanItemStatus;
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
  messages: NativeMessageState[];
  askUser: NativeAskUserState | null;
  slashCommands: NativeSlashCommand[];
  sessionId: string | null;
  remoteSessionId: string | null;
  remoteSessionCount: number;
  todos: NativePlanItemState[];
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
