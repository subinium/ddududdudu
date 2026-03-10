import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DEFAULT_ANTHROPIC_BASE_URL } from '../../api/anthropic-base-url.js';
import type { ApiMessage, ContentBlock, ToolUseContentBlock } from '../../api/anthropic-client.js';
import {
  createClient,
  getClientCapabilities,
  type ApiClient,
  type ApiClientCapabilities,
  type StreamEvent,
} from '../../api/client-factory.js';
import type { ToolResultBlock, ToolUseBlock } from '../../api/tool-executor.js';
import { formatToolsForApi } from '../../api/tool-executor.js';
import { discoverAllProviders, type ProviderAuth } from '../../auth/discovery.js';
import { ChecksRunner } from '../../core/checks.js';
import { loadConfig } from '../../core/config.js';
import { deleteDduduConfigValue, setDduduConfigValue } from '../../core/config-editor.js';
import {
  BackgroundJobStore,
  resolveBackgroundJobDirectory,
  type BackgroundJobChecklistItem,
  type BackgroundJobRecord,
} from '../../core/background-jobs.js';
import {
  buildArtifactPayload,
  formatArtifactContextLine,
  formatArtifactForHandoff,
  formatArtifactForInspector,
} from '../../core/artifacts.js';
import { CompactionEngine, type CompactionMessage } from '../../core/compaction.js';
import { DriftDetector } from '../../core/drift-detector.js';
import { EpistemicStateManager } from '../../core/epistemic-state.js';
import { formatBriefing, generateBriefing, loadBriefing, saveBriefing } from '../../core/briefing.js';
import { deriveContextProfile, type ContextProfile } from '../../core/context-profile.js';
import { DelegationRuntime, type DelegationPurpose } from '../../core/delegation.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../core/default-prompts.js';
import { GitCheckpoint } from '../../core/git-checkpoint.js';
import { loadHookFiles } from '../../core/hook-loader.js';
import { HookRegistry } from '../../core/hooks.js';
import { initializeProject } from '../../core/project-init.js';
import { LspManager } from '../../core/lsp-manager.js';
import { appendMemory, clearMemory, loadMemory, loadSelectedMemory, saveMemory, type MemoryScope } from '../../core/memory.js';
import { resolveModeBinding, type HarnessProviderName } from '../../core/mode-resolution.js';
import { loadOrchestratorPrompt, loadSystemPrompt } from '../../core/prompts.js';
import { SessionManager } from '../../core/session.js';
import { SkillLoader, type LoadedSkill } from '../../core/skill-loader.js';
import {
  getSpecialistRoleProfile,
  type SpecialistRole,
} from '../../core/specialist-roles.js';
import { runTeamAgentDelegation } from '../../core/team-execution.js';
import { type AgentRole as TeamAgentRole } from '../../core/team-agent.js';
import { TokenCounter } from '../../core/token-counter.js';
import {
  analyzeToolRisk,
  analyzeTrustBoundary,
  shouldPromptForRisk,
  type ToolRiskAssessment,
} from '../../core/trust.js';
import { getDduduPaths } from '../../core/dirs.js';
import type {
  DduduConfig,
  NamedMode,
  SessionListItem,
  ToolPolicy,
  TrustTier,
} from '../../core/types.js';
import { type VerificationMode, type VerificationSummary, VerificationRunner } from '../../core/verifier.js';
import { type IsolatedWorkspace, WorktreeManager } from '../../core/worktree-manager.js';
import {
  type PermissionProfile,
  type PlanItem,
  type PlanItemStatus,
  type WorkflowArtifact,
  type WorkflowArtifactKind,
  type WorkflowArtifactPayload,
  type WorkflowStateSnapshot,
} from '../../core/workflow-state.js';
import type { WorkAllocationPlan } from '../../core/work-allocation.js';
import { McpManager, type McpServerConfig, type McpTool } from '../../mcp/client.js';
import type { ToolContext } from '../../tools/index.js';
import type { Tool, ToolParameter } from '../../tools/index.js';
import { ToolRegistry } from '../../tools/registry.js';
import { discoverToolboxTools } from '../../tools/toolbox.js';
import { BP_LYRICS, HARNESS_MODES, MODE_ORDER } from '../shared/theme.js';
import { SLASH_COMMANDS } from '../shared/types.js';
import {
  buildCompactionMessages,
  type CompactionBuildOptions,
  type CliBackedRequestMode,
  type CliBackedSessionState,
  countApiMessageTokens,
  createRequestEstimate,
} from './session-support.js';
import {
  BackgroundCoordinator,
  type BackgroundUiJobState,
  type DetachedAgentActivityState,
} from './background-coordinator.js';
import {
  formatAgentActivityHeartbeat,
  buildDelegationHookContext,
} from './controller-support.js';
import { RequestEngine } from './request-engine.js';
import {
  classifyJennieAutoRoute,
  createTeamExecutionPlanDraft,
  formatAutoRouteNotice,
  shouldRunPlanningInterview,
  type AutoRouteDecision,
} from './routing-coordinator.js';
import {
  formatTeamAgentDetail,
  formatTeamAgentLabel,
  isRunnableTeamAgent,
  teamAgentPurpose,
  TeamExecutionCoordinator,
} from './team-execution-coordinator.js';
import { WorkflowStateStore, type WorkflowStateSource } from './workflow-state-store.js';
import type {
  NativeBridgeEvent,
  NativeLspState,
  NativeMessageState,
  NativeMcpState,
  NativeProviderState,
  NativeRequestEstimateState,
  NativeToolCallState,
  NativeTuiState,
  NativeVerificationState,
  NativeWorkspaceState,
} from './protocol.js';

interface ProviderCredentials {
  token: string;
  tokenType: string;
  source: string;
}

interface RequestPlan {
  apiMessages: ApiMessage[];
  mode: CliBackedRequestMode;
  note: string | null;
  remoteSessionId: string | null;
}

interface ContextSnapshotOptions {
  includeRelevantFiles?: boolean;
  includeChangedFiles?: boolean;
  includeBriefing?: boolean;
  includePlan?: boolean;
  includeUncertainties?: boolean;
  includeOperationalState?: boolean;
  includeMemory?: boolean;
  memoryScopes?: MemoryScope[];
  maxArtifacts?: number;
}

interface TimedCacheEntry<T> {
  value: T;
  expiresAt: number;
}

type AgentActivityState = DetachedAgentActivityState;
type BackgroundJobState = BackgroundUiJobState;

type EmitFn = (event: NativeBridgeEvent) => void;
type AskUserResolver = {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
};

const execFileAsync = promisify(execFile);

const MAX_TOOL_TURNS_FALLBACK = 25;
const MEMORY_SCOPES: MemoryScope[] = ['global', 'project', 'working', 'episodic', 'semantic', 'procedural'];
const PROVIDER_NAMES = ['anthropic', 'openai', 'gemini'] as const;
const PROMPT_VERSION = process.env.DDUDU_VERSION ?? '0.4.2';
const DEFAULT_PERMISSION_PROFILE: PermissionProfile = 'workspace-write';
const MAX_BACKGROUND_JOBS = 4;
const STATUS_FILE_PATTERN = /^[ MADRCU?!]{1,2}\s+(.+)$/;
const DIFF_FILE_PATTERN = /^\+\+\+\s+b\/(.+)$/gm;
const PARALLEL_SAFE_TOOL_NAMES = new Set([
  'read_file',
  'list_dir',
  'git_status',
  'git_diff',
  'grep',
  'glob',
  'repo_map',
  'symbol_search',
  'definition_search',
  'reference_search',
  'reference_hotspots',
  'changed_files',
  'file_importance',
  'codebase_search',
  'docs_lookup',
  'web_search',
  'web_fetch',
]);

const normalizeToolName = (name: string): string => name.trim().toLowerCase();
const isParallelSafeToolCall = (name: string): boolean => PARALLEL_SAFE_TOOL_NAMES.has(normalizeToolName(name));
const buildSyntheticToolActivityId = (assistantMessageId: string, toolUseId: string): string =>
  `tool:${assistantMessageId}:${toolUseId}`;

const normalizeProviders = (
  providers: Map<string, ProviderAuth>,
): Map<string, ProviderCredentials> => {
  const normalized = new Map<string, ProviderCredentials>(
    Array.from(providers.entries()).map(([provider, auth]) => [
      provider,
      { token: auth.token, tokenType: auth.tokenType, source: auth.source },
    ]),
  );

  const claude = normalized.get('claude');
  if (claude && !normalized.has('anthropic')) {
    normalized.set('anthropic', claude);
  }

  const codex = normalized.get('codex');
  if (codex && !normalized.has('openai')) {
    normalized.set('openai', codex);
  }

  return normalized;
};

const getRandomLyric = (): string => {
  const index = Math.floor(Math.random() * BP_LYRICS.length);
  return BP_LYRICS[index] ?? 'BLACKPINK in your area...';
};

const toApiMessages = (messages: NativeMessageState[]): ApiMessage[] => {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content,
    }));
};

const toToolResultContent = (results: ToolResultBlock[]): ContentBlock[] => {
  return results.map((result) => ({
    type: 'tool_result',
    tool_use_id: result.tool_use_id,
    content: result.content,
    is_error: result.is_error,
  }));
};

const toAssistantToolUseContent = (
  text: string,
  blocks: ToolUseContentBlock[],
): ContentBlock[] => {
  const payload: ContentBlock[] = [];
  if (text.trim().length > 0) {
    payload.push({ type: 'text', text });
  }

  return payload.concat(blocks);
};

const resolveProviderConfigName = (provider: string): string => {
  if (provider === 'anthropic') {
    return 'claude';
  }

  return provider;
};

const buildFallbackSystemPrompt = (mode: NamedMode, model?: string, provider?: string): string => {
  const modeConfig = HARNESS_MODES[mode] ?? HARNESS_MODES.jennie;
  const cwd = process.cwd();
  const projectName = basename(cwd) || 'unknown-project';

  return DEFAULT_SYSTEM_PROMPT
    .replace(/\$\{model\}/g, model ?? modeConfig.model)
    .replace(/\$\{provider\}/g, provider ?? modeConfig.provider)
    .replace(/\$\{cwd\}/g, cwd)
    .replace(/\$\{projectName\}/g, projectName)
    .replace(/\$\{userInstructions\}/g, modeConfig.promptAddition.trim());
};

const clampMode = (mode: string): NamedMode => {
  if (mode === 'jennie' || mode === 'lisa' || mode === 'rosé' || mode === 'jisoo') {
    return mode;
  }

  return 'jennie';
};

const serializeError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
};

const isPermissionProfile = (value: unknown): value is PermissionProfile => {
  return value === 'plan' || value === 'ask' || value === 'workspace-write' || value === 'permissionless';
};

const normalizePermissionProfile = (value: unknown): PermissionProfile => {
  if (isPermissionProfile(value)) {
    return value;
  }

  if (value === 'auto') {
    return 'workspace-write';
  }

  if (value === 'deny') {
    return 'plan';
  }

  return value === 'ask' ? 'ask' : DEFAULT_PERMISSION_PROFILE;
};

const isToolPolicy = (value: unknown): value is ToolPolicy => {
  return value === 'inherit' || value === 'allow' || value === 'ask' || value === 'deny';
};

const isTrustTier = (value: unknown): value is TrustTier => {
  return value === 'trusted' || value === 'ask' || value === 'deny';
};

const toCompactionMessages = (messages: NativeMessageState[]): CompactionMessage[] => {
  return buildCompactionMessages(messages).map((message) => ({
    role: message.role,
    content: message.content,
  }));
};

const toErrorMessage = (error: unknown): string => {
  const message = serializeError(error);
  return message.startsWith('[error]') ? message : `[error] ${message}`;
};

const getMaxTokens = (config: DduduConfig): number | undefined => {
  const maybeAgent = config.agent as unknown as Record<string, unknown>;
  const value = maybeAgent.max_tokens;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return undefined;
};

const normalizeSingleLine = (value: string): string => {
  return value.replace(/\s+/g, ' ').trim();
};

const previewText = (value: string, maxLength: number = 96): string => {
  const normalized = normalizeSingleLine(value);
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const purposeWorkerRole = (purpose?: string | null): string => {
  switch (purpose) {
    case 'planning':
      return 'planner';
    case 'research':
      return 'research';
    case 'review':
      return 'review';
    case 'design':
      return 'design';
    case 'execution':
      return 'executor';
    case 'oracle':
      return 'oracle';
    default:
      return 'delegate';
  }
};

const formatModeWorkerLabel = (mode: NamedMode | null | undefined, purpose?: string | null): string => {
  if (!mode) {
    return purposeWorkerRole(purpose);
  }

  return `${HARNESS_MODES[mode].label} · ${purposeWorkerRole(purpose)}`;
};

const buildDelegateTaskLabel = (purpose: DelegationPurpose | 'general'): string => {
  switch (purpose) {
    case 'planning':
      return 'Define scope and success criteria';
    case 'research':
      return 'Collect supporting evidence';
    case 'review':
      return 'Review risks and verification gaps';
    case 'design':
      return 'Produce the design change set';
    case 'execution':
      return 'Implement the requested change';
    case 'oracle':
      return 'Produce a second-opinion review';
    default:
      return 'Complete the delegated task';
  }
};

const formatRiskConcerns = (assessment: ToolRiskAssessment): string => {
  if (assessment.concerns.length === 0) {
    return assessment.level;
  }

  return `${assessment.level} · ${assessment.concerns.join(', ')}`;
};

const createChecklistItem = (
  id: string,
  label: string,
  status: BackgroundJobChecklistItem['status'],
  options: {
    owner?: string | null;
    detail?: string | null;
    dependsOn?: string[];
    handoffTo?: string | null;
  } = {},
): BackgroundJobChecklistItem => ({
  id,
  label,
  owner: options.owner ?? null,
  status,
  detail: options.detail ?? null,
  dependsOn:
    options.dependsOn && options.dependsOn.length > 0 ? Array.from(new Set(options.dependsOn)) : undefined,
  handoffTo: options.handoffTo ?? null,
  updatedAt: Date.now(),
});

const getChecklistTodoRef = (
  checklist: BackgroundJobChecklistItem[],
  itemId: string,
): string | null => {
  const index = checklist.findIndex((item) => item.id === itemId);
  return index >= 0 ? `todo #${index + 1}` : null;
};

const formatChecklistLinkedDetail = (
  checklist: BackgroundJobChecklistItem[],
  checklistId: string | null | undefined,
  detail: string | null | undefined,
): string | null => {
  const todoRef = checklistId ? getChecklistTodoRef(checklist, checklistId) : null;
  const normalizedDetail = detail?.trim() ? detail.trim() : null;
  if (todoRef && normalizedDetail) {
    return `${todoRef} · ${normalizedDetail}`;
  }

  return todoRef ?? normalizedDetail;
};

const buildDelegateJobChecklist = (
  purpose: DelegationPurpose | 'general',
  mode: NamedMode | null,
  verificationMode: VerificationMode | undefined,
): BackgroundJobChecklistItem[] => {
  const owner = mode ? HARNESS_MODES[mode].label : 'Delegate';
  const items: BackgroundJobChecklistItem[] = [
    createChecklistItem('execute', buildDelegateTaskLabel(purpose), 'in_progress', { owner }),
  ];

  if (verificationMode && verificationMode !== 'none') {
    items.push(
      createChecklistItem('verify', 'Run verification checks', 'blocked', {
        owner,
        dependsOn: ['execute'],
      }),
    );
  }

  if (purpose === 'execution' || purpose === 'design') {
    items.push(
      createChecklistItem('apply', 'Land workspace changes', 'blocked', {
        owner: 'ddudu',
        dependsOn: verificationMode && verificationMode !== 'none' ? ['verify'] : ['execute'],
      }),
    );
  }
  return items;
};

const buildTeamJobChecklist = (
  teamAgents: TeamAgentRole[],
  strategy: 'parallel' | 'sequential' | 'delegate',
): BackgroundJobChecklistItem[] => {
  const workerItems = teamAgents
    .filter((agent) => isRunnableTeamAgent(agent))
    .map((agent) =>
      createChecklistItem(
        `agent:${agent.id}`,
        agent.taskLabel ?? `Run ${agent.name}`,
        agent.dependencyLabels && agent.dependencyLabels.length > 0 ? 'blocked' : 'pending',
        {
          owner: formatTeamAgentLabel(agent),
          dependsOn:
            agent.dependencyUnitIds && agent.dependencyUnitIds.length > 0
              ? teamAgents
                  .filter(
                    (candidate) =>
                      typeof candidate.workUnitId === 'string' &&
                      agent.dependencyUnitIds?.includes(candidate.workUnitId),
                  )
                  .map((candidate) => `agent:${candidate.id}`)
              : undefined,
          handoffTo: agent.handoffTo ?? null,
          detail: [
            agent.readOnly ? 'read-only' : 'write',
            agent.dependencyLabels && agent.dependencyLabels.length > 0
              ? `blocked by ${agent.dependencyLabels.slice(0, 2).join(', ')}`
              : null,
            agent.handoffTo ? `handoff ${agent.handoffTo}` : null,
          ]
            .filter((part): part is string => Boolean(part))
            .join(' · ') || null,
        },
      ),
    );

  return [
    ...workerItems,
    createChecklistItem(
      'synthesize',
      `Merge ${strategy} worker output`,
      workerItems.length > 0 ? 'blocked' : 'pending',
      {
        owner: teamAgents.find((agent) => agent.role === 'lead')?.name ?? 'lead',
        dependsOn: workerItems.map((item) => item.id),
      },
    ),
  ];
};

const summarizeChecklistProgress = (checklist: BackgroundJobChecklistItem[]): string | null => {
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

const readString = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const summarizeToolInput = (name: string, input: Record<string, unknown>): string => {
  switch (name) {
    case 'read_file':
    case 'Read': {
      const path = readString(input.path) || readString(input.file_path);
      return path ? `read ${path}` : 'read file';
    }
    case 'write_file':
    case 'Write': {
      const path = readString(input.path) || readString(input.file_path);
      return path ? `write ${path}` : 'write file';
    }
    case 'edit_file':
    case 'Edit': {
      const path = readString(input.path) || readString(input.file_path);
      return path ? `edit ${path}` : 'edit file';
    }
    case 'list_dir': {
      const path = readString(input.path);
      return path ? `list ${path}` : 'list directory';
    }
    case 'bash':
    case 'Bash': {
      const command = previewText(readString(input.command), 72);
      return command ? `bash ${command}` : 'run shell command';
    }
    case 'grep':
    case 'Grep': {
      const pattern = previewText(readString(input.pattern), 32);
      const path = readString(input.path);
      if (pattern && path) {
        return `grep ${pattern} in ${path}`;
      }

      if (pattern) {
        return `grep ${pattern}`;
      }

      return 'grep search';
    }
    case 'glob':
    case 'Glob': {
      const pattern = previewText(readString(input.pattern), 40);
      const path = readString(input.path);
      if (pattern && path) {
        return `glob ${pattern} in ${path}`;
      }

      if (pattern) {
        return `glob ${pattern}`;
      }

      return 'glob search';
    }
    case 'repo_map': {
      const path = readString(input.path);
      return path ? `map ${path}` : 'map repository';
    }
    case 'symbol_search': {
      const query = previewText(readString(input.query), 48);
      return query ? `symbol ${query}` : 'symbol search';
    }
    case 'reference_search': {
      const query = previewText(readString(input.query), 48);
      return query ? `refs ${query}` : 'reference search';
    }
    case 'changed_files': {
      const path = readString(input.path);
      return path ? `changes ${path}` : 'changed files';
    }
    case 'codebase_search': {
      const query = previewText(readString(input.query), 48);
      return query ? `search ${query}` : 'codebase search';
    }
    case 'definition_search': {
      const query = previewText(readString(input.query), 48);
      return query ? `definition ${query}` : 'definition search';
    }
    case 'file_importance': {
      const query = previewText(readString(input.query), 48);
      return query ? `importance ${query}` : 'file importance';
    }
    case 'docs_lookup': {
      const query = previewText(readString(input.query), 60);
      return query ? `docs ${query}` : 'docs lookup';
    }
    case 'web_search':
    case 'WebSearch': {
      const query = previewText(readString(input.query), 60);
      return query ? `search ${query}` : 'web search';
    }
    case 'web_fetch':
    case 'WebFetch': {
      const url = previewText(readString(input.url), 72);
      return url ? `fetch ${url}` : 'fetch URL';
    }
    case 'task': {
      const prompt =
        previewText(readString(input.task), 60) || previewText(readString(input.prompt), 60);
      return prompt ? `delegate ${prompt}` : 'delegate task';
    }
    case 'Task': {
      const prompt = previewText(readString(input.description) || readString(input.prompt), 60);
      return prompt ? `delegate ${prompt}` : 'delegate task';
    }
    case 'oracle': {
      const prompt =
        previewText(readString(input.question), 60) || previewText(readString(input.prompt), 60);
      return prompt ? `oracle ${prompt}` : 'consult oracle';
    }
    case 'ask_question':
    case 'AskUserQuestion': {
      const question = previewText(readString(input.question), 60);
      return question ? `ask user ${question}` : 'ask user';
    }
    case 'memory': {
      const action = readString(input.action) || 'read';
      const scope = readString(input.scope);
      return scope ? `memory ${action} ${scope}` : `memory ${action}`;
    }
    case 'update_plan': {
      const action = readString(input.action) || 'list';
      const step = previewText(readString(input.step), 60);
      return step ? `plan ${action} ${step}` : `plan ${action}`;
    }
    case 'ToolSearch': {
      const query = previewText(readString(input.query), 60);
      return query ? `tool search ${query}` : 'tool search';
    }
    case 'Skill': {
      const query = previewText(readString(input.command) || readString(input.query), 60);
      return query ? `skill ${query}` : 'skill';
    }
    default:
      return name.replace(/_/g, ' ');
  }
};

const summarizeToolResult = (result: string): string => {
  return previewText(result.replace(/\s+/g, ' ').trim(), 160);
};

const hasMeaningfulMemory = (memory: string): boolean => {
  return memory
    .replace(/## Global Memory/gu, '')
    .replace(/## Project Memory/gu, '')
    .trim()
    .length > 0;
};

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const toToolParameter = (
  schema: unknown,
  requiredFields: Set<string> = new Set(),
  name?: string,
): ToolParameter => {
  if (!isObject(schema)) {
    return {
      type: 'string',
      description: name ? `${name} parameter` : 'parameter',
      required: name ? requiredFields.has(name) : undefined,
    };
  }

  const schemaType = typeof schema.type === 'string' ? schema.type : 'string';
  const type: ToolParameter['type'] =
    schemaType === 'number' || schemaType === 'boolean' || schemaType === 'array' || schemaType === 'object'
      ? schemaType
      : 'string';

  const parameter: ToolParameter = {
    type,
    description:
      typeof schema.description === 'string' && schema.description.trim().length > 0
        ? schema.description.trim()
        : name
        ? `${name} parameter`
        : 'parameter',
    required: name ? requiredFields.has(name) : undefined,
  };

  if (Array.isArray(schema.enum)) {
    parameter.enum = schema.enum.filter(
      (entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0,
    );
  }

  if (type === 'array') {
    parameter.items = toToolParameter(schema.items);
  }

  if (type === 'object' && isObject(schema.properties)) {
    const childRequired = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter(
            (entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0,
          )
        : [],
    );
    const properties: Record<string, ToolParameter> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      properties[key] = toToolParameter(value, childRequired, key);
    }
    parameter.properties = properties;
  }

  return parameter;
};

const buildMcpTool = (manager: McpManager, tool: McpTool): Tool => {
  const rootSchema = isObject(tool.inputSchema) ? tool.inputSchema : {};
  const required = new Set(
    Array.isArray(rootSchema.required)
      ? rootSchema.required.filter(
          (entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0,
        )
      : [],
  );
  const parameters: Record<string, ToolParameter> = {};
  const properties = isObject(rootSchema.properties) ? rootSchema.properties : {};

  for (const [name, value] of Object.entries(properties)) {
    parameters[name] = toToolParameter(value, required, name);
  }

  return {
    definition: {
      name: tool.name,
      description: tool.description || `MCP tool ${tool.name}`,
      parameters,
    },
    async execute(args): Promise<{ output: string; isError?: boolean }> {
      try {
        const output = await manager.callTool(tool.name, args);
        return { output };
      } catch (error: unknown) {
        return {
          output: serializeError(error),
          isError: true,
        };
      }
    },
  };
};

export class NativeBridgeController {
  private readonly emit: EmitFn;
  private config: DduduConfig | null = null;
  private readonly state: NativeTuiState = {
    ready: false,
    version: PROMPT_VERSION,
    cwd: process.cwd(),
    mode: 'jennie',
    modes: [],
    provider: 'anthropic',
    model: HARNESS_MODES.jennie.model,
    models: [],
    authType: null,
    authSource: null,
    permissionProfile: DEFAULT_PERMISSION_PROFILE,
    loading: false,
    loadingLabel: '',
    loadingSince: null,
    playingWithFire: false,
    contextPercent: 0,
    contextTokens: 0,
    contextLimit: 0,
    contextPreview: null,
    requestEstimate: null,
    queuedPrompts: [],
    providers: [],
    mcp: null,
    lsp: null,
    messages: [],
    askUser: null,
    slashCommands: SLASH_COMMANDS.map((item) => ({
      label: item.label,
      description: item.description,
      value: item.value,
    })),
    sessionId: null,
    remoteSessionId: null,
    remoteSessionCount: 0,
    teamRunStrategy: null,
    teamRunTask: null,
    teamRunSince: null,
    todos: [],
    agentActivities: [],
    backgroundJobs: [],
    artifacts: [],
    workspace: null,
    verification: null,
    error: null,
  };

  private currentMode: NamedMode = 'jennie';
  private selectedModels: Record<NamedMode, string> = {
    jennie: HARNESS_MODES.jennie.model,
    lisa: HARNESS_MODES.lisa.model,
    'rosé': HARNESS_MODES['rosé'].model,
    jisoo: HARNESS_MODES.jisoo.model,
  };
  private availableProviders = new Map<string, ProviderCredentials>();
  private activeClient: ApiClient | null = null;
  private toolRegistry: ToolRegistry | null = null;
  private sessionManager: SessionManager | null = null;
  private backgroundJobStore: BackgroundJobStore | null = null;
  private mcpManager: McpManager | null = null;
  private readonly loadedSkills = new Map<string, LoadedSkill>();
  private tokenCounter = new TokenCounter(HARNESS_MODES.jennie.model);
  private systemPrompt = buildFallbackSystemPrompt('jennie');
  private orchestratorPrompt: string | null = null;
  private permissionProfile: PermissionProfile = DEFAULT_PERMISSION_PROFILE;
  private lastSafePermissionProfile: PermissionProfile = DEFAULT_PERMISSION_PROFILE;
  private todos: PlanItem[] = [];
  private agentActivities: AgentActivityState[] = [];
  private backgroundJobs: BackgroundJobState[] = [];
  private artifacts: WorkflowArtifact[] = [];
  private readonly epistemicState = new EpistemicStateManager();
  private abortController: AbortController | null = null;
  private activeOperation: 'request' | 'team' | null = null;
  private activeAssistantMessageId: string | null = null;
  private queuedPrompts: string[] = [];
  private pendingAskUser: AskUserResolver | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private backgroundJobPollTimer: NodeJS.Timeout | null = null;
  private idleWarmupTimer: NodeJS.Timeout | null = null;
  private teamRunSince: number | null = null;
  private teamRunStrategy: 'parallel' | 'sequential' | 'delegate' | null = null;
  private teamRunTask: string | null = null;
  private teamLastSummary: string | null = null;
  private readonly compactionEngine = new CompactionEngine();
  private readonly hookRegistry = new HookRegistry();
  private readonly lspManager = new LspManager(process.cwd());
  private readonly remoteSessions = new Map<string, CliBackedSessionState>();
  private readonly backgroundCoordinator = new BackgroundCoordinator({
    previewText,
    formatChecklistLinkedDetail,
  });
  private readonly verificationRepairFingerprints = new Map<string, number>();
  private readonly memoryPromotionFingerprints = new Set<string>();
  private readonly worktreeManager = new WorktreeManager(process.cwd());
  private readonly requestEngine = new RequestEngine();
  private readonly teamExecutionCoordinator = new TeamExecutionCoordinator();
  private readonly workflowStateStore = new WorkflowStateStore();
  private readonly teamRunIsolatedNotes: string[] = [];
  private readonly selectedMemoryCache = new Map<string, TimedCacheEntry<string>>();
  private readonly promptContextCache = new Map<string, TimedCacheEntry<string>>();
  private changedFilesCache: TimedCacheEntry<string[]> | null = null;
  private briefingCache: TimedCacheEntry<{
    artifactDir: string | null;
    briefing: { summary: string; nextSteps: string[] } | null;
  }> | null = null;
  private lastEmittedStateSerialized: string | null = null;

  public constructor(emit: EmitFn) {
    this.emit = emit;
  }

  public async boot(): Promise<void> {
    this.config = await loadConfig();
    this.currentMode = clampMode(this.config.mode);
    this.state.mode = this.currentMode;
    this.permissionProfile = normalizePermissionProfile(this.config.tools.permission);
    this.lastSafePermissionProfile =
      this.permissionProfile === 'permissionless' ? DEFAULT_PERMISSION_PROFILE : this.permissionProfile;
    this.state.permissionProfile = this.permissionProfile;
    this.state.playingWithFire = this.permissionProfile === 'permissionless';
    this.systemPrompt = buildFallbackSystemPrompt(
      this.currentMode,
      this.selectedModels[this.currentMode],
    );

    for (const modeName of MODE_ORDER) {
      this.selectedModels[modeName] = HARNESS_MODES[modeName].model;
    }

    const providers = await discoverAllProviders();
    this.availableProviders = normalizeProviders(providers);
    this.state.providers = this.buildProviderState();

    this.toolRegistry = new ToolRegistry();
    try {
      const toolboxTools = await discoverToolboxTools();
      for (const tool of toolboxTools) {
        this.toolRegistry.register(tool);
      }
    } catch (error: unknown) {
      this.appendSystemMessage(`[toolbox] ${serializeError(error)}`);
    }

    try {
      await this.initializeMcpTools();
    } catch (error: unknown) {
      this.appendSystemMessage(`[mcp] ${serializeError(error)}`);
    }
    this.syncMcpState();
    try {
      await loadHookFiles(process.cwd(), this.hookRegistry);
    } catch (error: unknown) {
      this.appendSystemMessage(`[hooks] ${serializeError(error)}`);
    }

    this.sessionManager = new SessionManager(this.config.session.directory);
    this.workflowStateStore.setSessionManager(this.sessionManager);
    this.backgroundJobStore = new BackgroundJobStore(
      resolveBackgroundJobDirectory(this.config.session.directory),
    );
    this.backgroundCoordinator.setStore(this.backgroundJobStore);
    try {
      const resumed = await this.resumeRequestedSession();
      if (!resumed) {
        const session = await this.sessionManager.create({
          provider: this.getCurrentProvider(),
          model: this.getCurrentModel(),
          metadata: {
            mode: this.currentMode,
          },
        });
        this.state.sessionId = session.id;
      }
      await this.hookRegistry.emit('onSessionStart', {
        sessionId: this.state.sessionId,
        provider: this.getCurrentProvider(),
        model: this.getCurrentModel(),
        resumed,
      });
    } catch (error: unknown) {
      this.appendSystemMessage(`[session] ${serializeError(error)}`);
    }

    await this.refreshSystemPrompt();
    this.reconfigureClient();
    await this.restoreEpistemicState();
    await this.pollBackgroundJobs();
    this.startBackgroundJobPolling();
    this.scheduleIdleWarmup();
    this.state.ready = true;
    this.emitStateNow();
    void this.refreshLspInBackground();
  }

  public shutdown(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.idleWarmupTimer) {
      clearTimeout(this.idleWarmupTimer);
      this.idleWarmupTimer = null;
    }

    if (this.state.sessionId) {
      void this.hookRegistry.emit('onSessionEnd', {
        sessionId: this.state.sessionId,
        provider: this.getCurrentProvider(),
        model: this.getCurrentModel(),
      });
    }
    if (this.backgroundJobPollTimer) {
      clearTimeout(this.backgroundJobPollTimer);
      this.backgroundJobPollTimer = null;
    }
    this.mcpManager?.disconnectAll();
    void this.lspManager.shutdown();
    this.abortCurrentRequest();
  }

  private startBackgroundJobPolling(): void {
    if (this.backgroundJobPollTimer) {
      clearTimeout(this.backgroundJobPollTimer);
    }
    this.scheduleBackgroundJobPoll();
  }

  private async refreshLspInBackground(): Promise<void> {
    try {
      await this.lspManager.refresh(process.cwd());
    } catch (error: unknown) {
      this.appendSystemMessage(`[lsp] ${serializeError(error)}`);
    }
    this.syncLspState();
    this.scheduleStatePush();
  }

  private scheduleBackgroundJobPoll(delayMs?: number): void {
    if (this.backgroundJobPollTimer) {
      clearTimeout(this.backgroundJobPollTimer);
    }

    const delay = delayMs ?? (this.hasLiveBackgroundWork() ? 750 : 2400);
    this.backgroundJobPollTimer = setTimeout(() => {
      this.backgroundJobPollTimer = null;
      void this.pollBackgroundJobs().finally(() => {
        this.scheduleBackgroundJobPoll();
      });
    }, delay);
  }

  private hasLiveBackgroundWork(): boolean {
    return this.backgroundCoordinator.hasLiveBackgroundWork({
      foregroundLoading: this.state.loading,
      jobs: this.backgroundJobs,
      agentActivities: this.agentActivities,
    });
  }

  private async pollBackgroundJobs(): Promise<void> {
    if (!this.backgroundJobStore || !this.state.sessionId) {
      return;
    }

    try {
      const polled = await this.backgroundCoordinator.pollSession(this.state.sessionId);
      this.backgroundJobs = polled.jobs;
      this.syncBackgroundJobs();
      const live = this.agentActivities.filter((activity) => !activity.id.startsWith('job:'));
      this.agentActivities = [...live, ...polled.detachedActivities];
      this.syncAgentActivities();
      for (const job of polled.transitioned) {
        const jobRef = job.id.slice(0, 8);
        this.appendSystemMessage(
          `[background] ${job.label} ${
            job.status === 'done' ? 'finished' : job.status === 'cancelled' ? 'cancelled' : 'failed'
          } · /jobs result ${jobRef}`,
        );
        if (job.status === 'done' && job.result?.verification?.status === 'passed') {
          const mode = job.result.mode === 'jennie' || job.result.mode === 'lisa' || job.result.mode === 'rosé' || job.result.mode === 'jisoo'
            ? job.result.mode
            : (job.preferredMode ?? this.currentMode);
          await this.finalizeVerificationRecovery({
            reason: job.reason,
            purpose: job.purpose ?? 'general',
            output: job.result.text,
            mode,
            appliedToBase:
              job.result.workspaceApply?.applied ?? !job.result.workspaceApply?.attempted,
            verification: job.result.verification,
          });
        }
        if (job.status === 'done' && job.result?.verification) {
          await this.maybeScheduleVerificationFollowup({
            purpose: job.purpose ?? 'general',
            userPrompt: job.prompt,
            assistantOutput: job.result.text,
            verification: job.result.verification,
            allowRepair: job.reason !== 'verification auto-retry',
          });
        }
      }
      this.scheduleStatePush();
    } catch (error: unknown) {
      this.state.error = `[jobs] ${serializeError(error)}`;
      this.scheduleStatePush();
    }
  }

  private readTimedCache<T>(entry: TimedCacheEntry<T> | null): T | null {
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      return null;
    }

    return entry.value;
  }

  private writeTimedCache<T>(value: T, ttlMs: number): TimedCacheEntry<T> {
    return {
      value,
      expiresAt: Date.now() + ttlMs,
    };
  }

  private trimTimedMap<T>(map: Map<string, TimedCacheEntry<T>>, maxSize: number): void {
    if (map.size <= maxSize) {
      return;
    }

    const now = Date.now();
    for (const [key, entry] of map.entries()) {
      if (entry.expiresAt <= now) {
        map.delete(key);
      }
      if (map.size <= maxSize) {
        return;
      }
    }

    while (map.size > maxSize) {
      const oldest = map.keys().next().value;
      if (!oldest) {
        break;
      }
      map.delete(oldest);
    }
  }

  private invalidateDerivedCaches(options: {
    changedFiles?: boolean;
    briefing?: boolean;
    memory?: boolean;
    promptContext?: boolean;
  } = {}): void {
    if (options.changedFiles) {
      this.changedFilesCache = null;
    }
    if (options.briefing) {
      this.briefingCache = null;
    }
    if (options.memory) {
      this.selectedMemoryCache.clear();
    }
    if (options.promptContext || options.changedFiles || options.briefing || options.memory) {
      this.promptContextCache.clear();
    }
  }

  private buildPromptContextCacheKey(
    prompt: string | undefined,
    purpose: DelegationPurpose | 'general',
    options: Required<ContextSnapshotOptions>,
  ): string {
    const activeAgents = this.agentActivities
      .filter((item) => item.status === 'running' || item.status === 'verifying' || item.status === 'queued')
      .slice(0, 4)
      .map((item) => `${item.id}:${item.status}:${item.updatedAt}`)
      .join('|');
    const activeJobs = this.backgroundJobs
      .filter((job) => job.status === 'running')
      .slice(0, 4)
      .map((job) => `${job.id}:${job.updatedAt}`)
      .join('|');
    const todoSignature = this.todos
      .slice(0, 8)
      .map((item) => `${item.id}:${item.status}`)
      .join('|');
    const artifactSignature = this.artifacts
      .slice(0, 6)
      .map((artifact) => `${artifact.id}:${artifact.kind}`)
      .join('|');

    return JSON.stringify({
      prompt,
      purpose,
      options,
      mode: this.currentMode,
      provider: this.getCurrentProvider(),
      model: this.getCurrentModel(),
      permission: this.permissionProfile,
      workspace: this.state.workspace?.path ?? null,
      sessionId: this.state.sessionId,
      todoSignature,
      artifactSignature,
      activeAgents,
      activeJobs,
      uncertaintyCount: this.epistemicState.getStats().uncertainties,
    });
  }

  private async getBriefingSummary(): Promise<{ summary: string; nextSteps: string[] } | null> {
    const artifactDir = this.getSessionArtifactDirectory();
    const cached = this.readTimedCache(this.briefingCache);
    if (cached && cached.artifactDir === artifactDir) {
      return cached.briefing;
    }

    if (!artifactDir) {
      this.briefingCache = this.writeTimedCache({ artifactDir: null, briefing: null }, 1200);
      return null;
    }

    try {
      const briefing = await loadBriefing(artifactDir);
      const normalized = briefing
        ? {
            summary: previewText(briefing.summary, 220),
            nextSteps: briefing.nextSteps.slice(0, 5),
          }
        : null;
      this.briefingCache = this.writeTimedCache({ artifactDir, briefing: normalized }, 1200);
      return normalized;
    } catch {
      this.briefingCache = this.writeTimedCache({ artifactDir, briefing: null }, 600);
      return null;
    }
  }

  private async getCachedSelectedMemory(scopes: MemoryScope[], maxChars: number): Promise<string> {
    const key = `${scopes.join(',')}::${maxChars}`;
    const cached = this.selectedMemoryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const value = await loadSelectedMemory(process.cwd(), scopes, maxChars);
    this.selectedMemoryCache.set(key, this.writeTimedCache(value, 2000));
    this.trimTimedMap(this.selectedMemoryCache, 12);
    return value;
  }

  private scheduleIdleWarmup(prompt?: string, purpose?: DelegationPurpose | 'general'): void {
    if (this.idleWarmupTimer) {
      clearTimeout(this.idleWarmupTimer);
    }

    this.idleWarmupTimer = setTimeout(() => {
      this.idleWarmupTimer = null;
      void this.warmIdleCaches(prompt, purpose);
    }, prompt ? 220 : 500);
  }

  private async warmIdleCaches(prompt?: string, purpose?: DelegationPurpose | 'general'): Promise<void> {
    if (this.state.loading || this.abortController) {
      return;
    }

    try {
      const tasks: Array<Promise<unknown>> = [
        this.getChangedFiles(10),
        this.getBriefingSummary(),
        this.getCachedSelectedMemory(this.getSystemMemoryScopes(this.currentMode), 360),
      ];

      const trimmedPrompt = prompt?.trim();
      if (trimmedPrompt && !trimmedPrompt.startsWith('/')) {
        const inferredPurpose = purpose ?? this.inferPromptPurpose(trimmedPrompt);
        tasks.push(
          this.buildPromptContextSnapshot(
            trimmedPrompt,
            inferredPurpose,
            this.getPromptContextSnapshotOptions(trimmedPrompt, inferredPurpose, 'request'),
          ).catch(() => ''),
        );
      }

      await Promise.all(tasks);
    } catch {
      // Warmup is best-effort only.
    }
  }

  public prefetchContext(content: string): void {
    const trimmed = content.trim();
    if (!trimmed || trimmed.startsWith('/')) {
      return;
    }
    this.scheduleIdleWarmup(trimmed);
  }

  private resolveCliEntrypoint(): string {
    return fileURLToPath(new URL('../../index.js', import.meta.url));
  }

  private async spawnDetachedBackgroundJob(jobId: string): Promise<void> {
    const child = spawn(
      process.execPath,
      [this.resolveCliEntrypoint(), 'job', 'run', jobId],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          DDUDU_BACKGROUND_JOB: '1',
        },
      },
    );

    child.unref();
  }

  public appendSystemMessage(content: string): void {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }

    this.state.messages.push({
      id: randomUUID(),
      role: 'system',
      content: trimmed,
      timestamp: Date.now(),
    });
    if (this.sessionManager && this.state.sessionId) {
      void this.sessionManager.append(this.state.sessionId, {
        type: 'message',
        timestamp: new Date().toISOString(),
        data: {
          system: trimmed,
          mode: this.currentMode,
        },
      });
    }
    this.scheduleStatePush();
  }

  public clearMessages(): void {
    this.state.messages = [];
    this.remoteSessions.clear();
    this.updateRemoteSessionState();
    this.scheduleStatePush();
  }

  public async runSlashCommand(command: string): Promise<void> {
    const trimmed = command.trim();
    if (!trimmed) {
      return;
    }

    const [head, ...rest] = trimmed.split(/\s+/);

    switch (head) {
      case '/clear':
        this.clearMessages();
        return;
      case '/fire':
        this.toggleFire();
        return;
      case '/mode': {
        const mode = rest[0];
        if (mode && (mode === 'jennie' || mode === 'lisa' || mode === 'rosé' || mode === 'jisoo')) {
          this.setMode(mode);
        } else {
          this.appendSystemMessage('Use /mode <jennie|lisa|rosé|jisoo>.');
        }
        return;
      }
      case '/model': {
        const model = rest[0];
        if (model) {
          this.setModel(model);
        } else {
          this.appendSystemMessage(`Current models: ${this.state.models.join(', ')}`);
        }
        return;
      }
      case '/compact':
        await this.compactContext();
        return;
      case '/help':
        this.appendSystemMessage(
          'Available commands: /clear, /compact, /mode, /model, /plan, /todo, /permissions, /memory, /session, /config, /help, /doctor, /context, /review, /queue, /jobs, /artifacts, /checkpoint, /undo, /handoff, /fork, /briefing, /drift, /quit, /exit, /fire, /init, /skill, /hook, /mcp, /team (/jobs inspect|logs|result|retry|promote|cancel)',
        );
        return;
      case '/plan':
        this.appendSystemMessage(this.formatPlanSummary());
        return;
      case '/todo':
        this.appendSystemMessage(await this.runTodoCommand(rest));
        return;
      case '/permissions':
        this.appendSystemMessage(await this.runPermissionsCommand(rest));
        return;
      case '/config':
        this.appendSystemMessage(this.formatConfigSummary());
        return;
      case '/doctor':
        this.appendSystemMessage(this.formatDoctorSummary());
        return;
      case '/context':
        this.appendSystemMessage(await this.formatContextSummary());
        return;
      case '/review':
        this.appendSystemMessage(await this.runReviewSummary());
        return;
      case '/queue':
        this.appendSystemMessage(await this.runQueueCommand(rest));
        return;
      case '/jobs':
        this.appendSystemMessage(await this.runJobsCommand(rest));
        return;
      case '/artifacts':
        this.appendSystemMessage(this.formatArtifactSummary());
        return;
      case '/checkpoint':
        this.appendSystemMessage(await this.runCheckpointCommand(rest.join(' ')));
        return;
      case '/undo':
        this.appendSystemMessage(await this.runUndoCommand());
        return;
      case '/handoff':
        this.appendSystemMessage(await this.runHandoffCommand(rest.join(' ')));
        return;
      case '/fork':
        this.appendSystemMessage(await this.runForkCommand(rest.join(' ')));
        return;
      case '/briefing':
        this.appendSystemMessage(await this.runBriefingCommand());
        return;
      case '/drift':
        this.appendSystemMessage(await this.runDriftCommand());
        return;
      case '/session':
        this.appendSystemMessage(await this.runSessionCommand(rest));
        return;
      case '/memory':
        this.appendSystemMessage(await this.runMemoryCommand(rest));
        return;
      case '/skill':
        if (rest.length === 0) {
          this.appendSystemMessage(await this.formatSkillSummary());
        } else {
          this.appendSystemMessage(await this.loadSkillSummary(rest.join(' ')));
        }
        return;
      case '/mcp':
        this.appendSystemMessage(await this.runMcpCommand(rest));
        return;
      case '/hook':
        this.appendSystemMessage(await this.runHookCommand(rest));
        return;
      case '/team':
        this.appendSystemMessage(await this.runTeamCommand(rest));
        return;
      case '/init':
        this.appendSystemMessage(await this.runInitSummary());
        return;
      case '/quit':
      case '/exit':
        this.appendSystemMessage('Use /quit from the native TUI directly to exit.');
        return;
      default:
        this.appendSystemMessage(`Unknown command: ${trimmed}`);
        return;
    }
  }

  public cycleMode(direction: 1 | -1 = 1): void {
    const currentIndex = MODE_ORDER.indexOf(this.currentMode);
    const nextIndex = (currentIndex + direction + MODE_ORDER.length) % MODE_ORDER.length;
    this.setMode(MODE_ORDER[nextIndex] ?? 'jennie');
  }

  public setMode(mode: NamedMode): void {
    const previousMode = this.currentMode;
    this.currentMode = clampMode(mode);
    this.state.mode = this.currentMode;
    this.reconfigureClient();
    void this.refreshSystemPrompt();
    void this.hookRegistry.emit('onModeSwitch', {
      from: previousMode,
      to: this.currentMode,
      provider: this.getCurrentProvider(),
      model: this.getCurrentModel(),
    });
    void this.persistWorkflowState('mode_switch');
    this.scheduleStatePush();
  }

  public setModel(model: string): void {
    const availableModels = this.resolveCurrentProviderModels();
    if (!availableModels.includes(model)) {
      this.appendSystemMessage(`[error] Unsupported model for ${this.getCurrentProvider()}: ${model}`);
      return;
    }

    this.selectedModels[this.currentMode] = model;
    this.reconfigureClient();
    void this.refreshSystemPrompt();
    void this.persistWorkflowState('model_switch');
    this.scheduleStatePush();
  }

  public toggleFire(): void {
    const nextProfile =
      this.permissionProfile === 'permissionless'
        ? this.lastSafePermissionProfile
        : 'permissionless';
    void this.setPermissionProfile(nextProfile);
  }

  public answerAskUser(answer: string): void {
    const pending = this.pendingAskUser;
    if (!pending) {
      return;
    }

    this.pendingAskUser = null;
    this.state.askUser = null;
    pending.resolve(answer);
    this.scheduleStatePush();
  }

  public abortCurrentRequest(): void {
    if (this.pendingAskUser) {
      const pending = this.pendingAskUser;
      this.pendingAskUser = null;
      this.state.askUser = null;
      pending.reject(new Error('Request aborted'));
    }

    const controller = this.abortController;
    if (!controller) {
      return;
    }

    controller.abort();

    if (this.activeAssistantMessageId) {
      this.finishMessage(this.activeAssistantMessageId, '[request aborted]');
    }

    if (this.activeOperation === 'request' && this.getProviderCapabilities(this.getCurrentProvider())?.supportsRemoteSession) {
      this.invalidateRemoteSession(this.getCurrentProvider());
    }

    this.state.loading = false;
    this.state.loadingLabel = '';
    this.state.loadingSince = null;
    this.state.requestEstimate = null;
    this.activeOperation = null;
    this.teamRunSince = null;
    this.teamRunStrategy = null;
    this.teamRunTask = null;
    this.abortController = null;
    this.activeAssistantMessageId = null;
    this.scheduleStatePush();
  }

  public async submit(content: string): Promise<void> {
    const trimmedContent = content.trim();
    if (!trimmedContent) {
      return;
    }

    if (this.state.loading && this.abortController) {
      if (await this.maybeStartBackgroundPrompt(trimmedContent)) {
        return;
      }
      this.queuedPrompts.push(trimmedContent);
      this.syncQueuedPrompts();
      return;
    }

    this.resetEphemeralAgentActivities();
    this.scheduleIdleWarmup(trimmedContent);

    const mode = this.currentMode;
    const model = this.getCurrentModel();
    await this.refreshSystemPrompt();

    if (await this.maybeHandleJennieAutoRoute(trimmedContent)) {
      return;
    }

    const directPurpose = this.inferPromptPurpose(trimmedContent);
    const requestContextSnapshot = await this.buildPromptContextSnapshot(
      trimmedContent,
      directPurpose,
      this.getPromptContextSnapshotOptions(trimmedContent, directPurpose, 'request'),
    );
    const requestSystemPrompt = requestContextSnapshot
      ? `${this.systemPrompt}\n\n${requestContextSnapshot}`
      : this.systemPrompt;
    this.state.contextPreview = requestContextSnapshot || this.state.contextPreview;
    this.tokenCounter.setModel(model);
    await this.maybeAutoCompact(trimmedContent);

    const userMessage: NativeMessageState = {
      id: randomUUID(),
      role: 'user',
      content: trimmedContent,
      timestamp: Date.now(),
    };
    const assistantMessage: NativeMessageState = {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };

    const requestPlan = await this.prepareRequestPlan(userMessage);

    this.state.messages.push(userMessage);
    this.state.messages.push(assistantMessage);
    this.state.loading = true;
    this.state.loadingLabel = getRandomLyric();
    this.state.loadingSince = Date.now();
    this.state.requestEstimate = this.estimateRequestForPlan(requestPlan);
    this.activeAssistantMessageId = assistantMessage.id;
    this.scheduleStatePush();

    if (!this.activeClient) {
      this.finishMessage(assistantMessage.id, '[error] No active provider. Run: ddudu auth login');
      this.state.loading = false;
      this.state.loadingLabel = '';
      this.state.loadingSince = null;
      this.state.requestEstimate = null;
      this.activeAssistantMessageId = null;
      this.scheduleStatePush();
      return;
    }

    const controller = new AbortController();
    this.abortController = controller;
    this.activeOperation = 'request';

    const clientCapabilities = this.activeClient.capabilities;
    const tools =
      clientCapabilities.supportsApiToolCalls && this.toolRegistry
        ? formatToolsForApi(this.toolRegistry)
        : undefined;
    const maxTokens = this.config ? getMaxTokens(this.config) : undefined;

    let fullText = '';
    let requestInputTokens = 0;
    let requestOutputTokens = 0;
    let requestUncachedInputTokens = 0;
    let requestCachedInputTokens = 0;
    let requestCacheWriteInputTokens = 0;
    let currentPlan = requestPlan;
    let activeRemoteSessionId = requestPlan.remoteSessionId;

    try {
      await this.hookRegistry.emit('beforeSend', {
        provider: this.getCurrentProvider(),
        model,
        sessionId: this.state.sessionId,
        remoteSessionId: currentPlan.remoteSessionId,
        requestMode: currentPlan.mode,
        prompt: trimmedContent,
      });

      const maxToolTurns = this.config?.agent.max_turns ?? MAX_TOOL_TURNS_FALLBACK;
      const result = await this.requestEngine.run(
        {
          client: this.activeClient,
          capabilities: clientCapabilities,
          provider: this.getCurrentProvider(),
          model,
          sessionId: this.state.sessionId,
          cwd: process.cwd(),
          plan: currentPlan,
          systemPrompt: requestSystemPrompt,
          tools,
          maxTokens,
          maxToolTurns,
          signal: controller.signal,
        },
        {
          beforeApiCall: async (input) => {
            await this.hookRegistry.emit('beforeApiCall', input);
          },
          afterApiCall: async (input) => {
            await this.hookRegistry.emit('afterApiCall', input);
          },
          consumeStream: async (input) =>
            this.consumeStream(input.stream, {
              assistantMessageId: assistantMessage.id,
              apiMessages: input.apiMessages,
              currentText: input.currentText,
              requestInputTokens: input.requestInputTokens,
              requestOutputTokens: input.requestOutputTokens,
              requestUncachedInputTokens: input.requestUncachedInputTokens,
              requestCachedInputTokens: input.requestCachedInputTokens,
              requestCacheWriteInputTokens: input.requestCacheWriteInputTokens,
              signal: input.signal,
              onSession: input.onSession,
            }),
          onSessionObserved: ({ sessionId, phase }) => {
            activeRemoteSessionId = sessionId;
            if (!clientCapabilities.supportsRemoteSession) {
              return;
            }

            this.rememberRemoteSession({
              provider: this.getCurrentProvider(),
              sessionId,
              lastModel: model,
              lastUsedAt: Date.now(),
              syncedMessageCount:
                phase === 'stream'
                  ? this.getCanonicalConversationCount() - 1
                  : this.getCanonicalConversationCount(),
            });
          },
          onRemoteSessionRetry: async () => {
            this.invalidateRemoteSession(this.getCurrentProvider());
            this.updateMessage(assistantMessage.id, '');
            const freshPlan = await this.prepareRequestPlan(userMessage, true);
            this.state.requestEstimate = this.estimateRequestForPlan(freshPlan);
            this.scheduleStatePush();
            return freshPlan;
          },
          onPlanUpdated: (plan) => {
            currentPlan = plan;
            activeRemoteSessionId = plan.remoteSessionId;
          },
          onMaxToolTurnsReached: () => {
            this.finishMessage(assistantMessage.id, '[error] Maximum tool turns reached');
          },
          serializeError,
        },
      );

      currentPlan = result.plan;
      activeRemoteSessionId = result.activeRemoteSessionId;
      fullText = result.fullText;
      requestInputTokens = result.inputTokens;
      requestOutputTokens = result.outputTokens;
      requestUncachedInputTokens = result.uncachedInputTokens;
      requestCachedInputTokens = result.cachedInputTokens;
      requestCacheWriteInputTokens = result.cacheWriteInputTokens;

      if (!controller.signal.aborted) {
        await this.hookRegistry.emit('afterResponse', {
          provider: this.getCurrentProvider(),
          model,
          sessionId: this.state.sessionId,
          remoteSessionId: activeRemoteSessionId,
          requestMode: currentPlan.mode,
          inputTokens: requestInputTokens,
          outputTokens: requestOutputTokens,
        });

        if (this.sessionManager && this.state.sessionId) {
          await this.sessionManager.append(this.state.sessionId, {
            type: 'message',
            timestamp: new Date().toISOString(),
            data: {
              user: trimmedContent,
              assistant: fullText,
              mode,
              requestMode: currentPlan.mode,
              remoteSessionId: activeRemoteSessionId,
              inputTokens: requestInputTokens,
              outputTokens: requestOutputTokens,
            },
          });
        }

        this.rememberSessionArtifact(directPurpose, fullText, trimmedContent);
        this.state.loadingLabel = 'verifier';
        this.scheduleStatePush();
        const verification = await this.runAutoVerification(process.cwd(), 'full');
        if (verification.status !== 'skipped') {
          this.appendSystemMessage(`[verify] ${verification.summary}`);
        }
        await this.finalizeVerificationRecovery({
          reason: null,
          purpose: directPurpose,
          output: fullText,
          mode,
          verification,
        });
        await this.maybeScheduleVerificationFollowup({
          purpose: directPurpose,
          userPrompt: trimmedContent,
          assistantOutput: fullText,
          verification,
        });
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        if (clientCapabilities.supportsRemoteSession) {
          this.invalidateRemoteSession(this.getCurrentProvider());
        }
        await this.hookRegistry.emit('onError', {
          provider: this.getCurrentProvider(),
          model,
          sessionId: this.state.sessionId,
          error: serializeError(error),
        });
        this.finishMessage(assistantMessage.id, toErrorMessage(error));
      }
    } finally {
      if (controller.signal.aborted && this.activeAssistantMessageId === assistantMessage.id) {
        this.finishMessage(assistantMessage.id, '[request aborted]');
      }

      this.state.loading = false;
      this.state.loadingLabel = '';
      this.state.loadingSince = null;
      this.state.requestEstimate = null;

      if (this.abortController === controller) {
        this.abortController = null;
      }
      if (this.activeOperation === 'request') {
        this.activeOperation = null;
      }

      if (this.activeAssistantMessageId === assistantMessage.id) {
        this.activeAssistantMessageId = null;
      }

      this.scheduleStatePush();

      const nextPrompt = this.queuedPrompts.shift();
      this.syncQueuedPrompts();
      if (nextPrompt) {
        await this.submit(nextPrompt);
      }
    }
  }

  private classifyJennieAutoRoute(prompt: string): AutoRouteDecision {
    return classifyJennieAutoRoute(prompt, this.getTeamEligibleModes());
  }

  private formatAutoRouteNotice(decision: AutoRouteDecision): string {
    return formatAutoRouteNotice(decision);
  }

  private shouldRunPlanningInterview(prompt: string, decision: AutoRouteDecision): boolean {
    return shouldRunPlanningInterview(prompt, decision);
  }

  private async runPlanningInterview(
    prompt: string,
    decision: AutoRouteDecision,
  ): Promise<{ prompt: string; artifact: WorkflowArtifact }> {
    const done = await this.promptForInput(
      'Before I split this up: what should count as done?',
      ['smallest correct change', 'production-ready result', 'plan first, then execute'],
    );
    const constraints = await this.promptForInput(
      'Any important constraints or things I should not break?',
      ['keep the API stable', 'minimal diff', 'no UI changes', 'none'],
    );
    const optimizeFor = await this.promptForInput(
      'What should I optimize for?',
      ['speed', 'minimal diff', 'thoroughness'],
    );

    const summary = [
      `Primary outcome: ${done || 'not specified'}`,
      `Constraints: ${constraints || 'none specified'}`,
      `Optimize for: ${optimizeFor || 'balanced execution'}`,
    ].join('\n');

    const artifact = this.rememberArtifact({
      kind: 'plan',
      title: `${HARNESS_MODES['rosé'].label} interview brief`,
      summary: `${previewText(prompt, 120)} · ${previewText(summary, 220)}`,
      payload: buildArtifactPayload({
        kind: 'plan',
        purpose: decision.purpose ?? 'planning',
        prompt,
        summary,
        notes: [done, constraints, optimizeFor].filter((value): value is string => Boolean(value && value.trim())),
      }),
      source: 'session',
      mode: 'rosé',
    });

    return {
      prompt: [
        prompt,
        '',
        '<planning_brief>',
        `done: ${done || 'not specified'}`,
        `constraints: ${constraints || 'none specified'}`,
        `optimize_for: ${optimizeFor || 'balanced execution'}`,
        '</planning_brief>',
      ].join('\n'),
      artifact,
    };
  }

  private canStartBackgroundJob(): boolean {
    const runningJobs = this.backgroundJobs.filter((job) => job.status === 'running').length;
    return runningJobs < MAX_BACKGROUND_JOBS;
  }

  private async maybeStartBackgroundPrompt(trimmedContent: string): Promise<boolean> {
    if (this.currentMode !== 'jennie' || !this.canStartBackgroundJob()) {
      return false;
    }

    const decision = this.classifyJennieAutoRoute(trimmedContent);
    if (decision.kind === 'direct') {
      return false;
    }

    const userMessage: NativeMessageState = {
      id: randomUUID(),
      role: 'user',
      content: trimmedContent,
      timestamp: Date.now(),
    };
    this.state.messages.push(userMessage);

    if (decision.kind === 'team') {
      await this.startBackgroundTeamRun(decision.strategy ?? 'parallel', trimmedContent, {
        routeNote: `${this.formatAutoRouteNotice(decision)} · background`,
      });
      return true;
    }

    await this.startBackgroundDelegatedRoute(userMessage, decision);
    return true;
  }

  private async maybeHandleJennieAutoRoute(trimmedContent: string): Promise<boolean> {
    if (this.currentMode !== 'jennie') {
      return false;
    }

    const decision = this.classifyJennieAutoRoute(trimmedContent);
    if (decision.kind === 'direct') {
      return false;
    }

    let routedContent = trimmedContent;
    if (this.shouldRunPlanningInterview(trimmedContent, decision)) {
      const interview = await this.runPlanningInterview(trimmedContent, decision);
      routedContent = interview.prompt;
      this.state.messages.push({
        id: randomUUID(),
        role: 'system',
        content: `Planning brief captured · ${interview.artifact.title}`,
        timestamp: Date.now(),
      });
    }

    const userMessage: NativeMessageState = {
      id: randomUUID(),
      role: 'user',
      content: trimmedContent,
      timestamp: Date.now(),
    };

    this.state.messages.push(userMessage);

    if (decision.kind === 'team') {
      await this.executeTeamRun(decision.strategy ?? 'parallel', routedContent, {
        routeNote: this.formatAutoRouteNotice(decision),
      });
      return true;
    }

    await this.executeDelegatedRoute(userMessage, decision, routedContent);
    return true;
  }

  private async startBackgroundDelegatedRoute(
    userMessage: NativeMessageState,
    decision: AutoRouteDecision,
  ): Promise<void> {
    const backgroundJobId = randomUUID();
    const label = decision.preferredMode
      ? `${HARNESS_MODES[decision.preferredMode].label} · ${decision.purpose ?? 'general'}`
      : `delegate · ${decision.purpose ?? 'general'}`;

    if (!this.backgroundJobStore) {
      this.appendSystemMessage('[jobs] Background worker unavailable.');
      return;
    }

    const contextSnapshot = await this.buildPromptContextSnapshot(
      userMessage.content,
      decision.purpose ?? 'general',
      this.getPromptContextSnapshotOptions(userMessage.content, decision.purpose ?? 'general', 'delegation'),
    );
    const purpose = decision.purpose ?? 'general';
    const artifactLimit = purpose === 'research' && this.isLikelyExternalResearchPrompt(userMessage.content) ? 1 : 4;
    const artifacts = this.getArtifactsForPurpose(purpose, artifactLimit);
    const checklist = buildDelegateJobChecklist(
      purpose,
      decision.preferredMode ?? null,
      this.verificationModeForPurpose(decision.purpose),
    );
    const record = await this.backgroundJobStore.create({
      id: backgroundJobId,
      sessionId: this.state.sessionId,
      kind: 'delegate',
      label,
      cwd: process.cwd(),
      prompt: userMessage.content,
      purpose,
      preferredMode: decision.preferredMode ?? null,
      preferredModel: decision.preferredMode ? this.selectedModels[decision.preferredMode] : null,
      reason: decision.reason,
      attempt: decision.repairAttempt ?? 0,
      verificationMode: this.verificationModeForPurpose(decision.purpose),
      contextSnapshot,
      artifacts,
      teamAgents: [],
      teamSharedContext: null,
      checklist,
      agentActivities: [
        {
          id: `job:${backgroundJobId}:delegate`,
          label: decision.preferredMode ? HARNESS_MODES[decision.preferredMode].label : 'Delegate',
          mode: decision.preferredMode ?? null,
          purpose,
          checklistId: 'execute',
          status: 'queued',
          detail: formatChecklistLinkedDetail(
            checklist,
            'execute',
            `queued · ${previewText(userMessage.content, 64)}`,
          ),
          workspacePath: null,
          updatedAt: Date.now(),
        },
      ],
      result: null,
      artifact: null,
    });

    this.backgroundJobs = [this.backgroundCoordinator.mapStoredJobToState(record), ...this.backgroundJobs.filter((job) => job.id !== record.id)];
    this.syncBackgroundJobs();
    const live = this.agentActivities.filter((activity) => !activity.id.startsWith('job:'));
    this.agentActivities = [...live, ...this.backgroundCoordinator.collectDetachedAgentActivities([record])];
    this.syncAgentActivities();
    this.scheduleStatePush();

    try {
      await this.spawnDetachedBackgroundJob(record.id);
      await this.pollBackgroundJobs();
    } catch (error: unknown) {
      await this.backgroundJobStore.update(record.id, {
        status: 'error',
        detail: serializeError(error),
        finishedAt: Date.now(),
      });
      await this.pollBackgroundJobs();
      throw error;
    }
  }

  private async executeDelegatedRoute(
    userMessage: NativeMessageState,
    decision: AutoRouteDecision,
    executionPrompt: string = userMessage.content,
  ): Promise<void> {
    this.resetEphemeralAgentActivities();
    const assistantMessage: NativeMessageState = {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };
    this.state.messages.push(assistantMessage);
    this.state.loading = true;
    this.state.loadingLabel = `route · ${decision.purpose ?? 'general'}`;
    this.state.loadingSince = Date.now();
    this.state.requestEstimate = null;
    this.activeAssistantMessageId = assistantMessage.id;
    this.scheduleStatePush();

    const controller = new AbortController();
    this.abortController = controller;
    this.activeOperation = 'request';
    const routeActivityId = randomUUID();
    this.updateAgentActivity({
      id: routeActivityId,
      label: formatModeWorkerLabel(decision.preferredMode ?? null, decision.purpose ?? 'general'),
      status: 'running',
      mode: decision.preferredMode ?? null,
      purpose: decision.purpose ?? 'general',
      detail: previewText(executionPrompt, 72),
    });

    try {
      const contextSnapshot = await this.buildPromptContextSnapshot(
        executionPrompt,
        decision.purpose ?? 'general',
        this.getPromptContextSnapshotOptions(executionPrompt, decision.purpose ?? 'general', 'delegation'),
      );
      await this.hookRegistry.emit('beforeSend', {
        provider: this.getCurrentProvider(),
        model: this.getCurrentModel(),
        sessionId: this.state.sessionId,
        remoteSessionId: null,
        requestMode: 'full',
        prompt: executionPrompt,
      });

      const runtime = this.createDelegationRuntime();
      const routePurpose = decision.purpose ?? 'general';
      const artifactLimit = routePurpose === 'research' && this.isLikelyExternalResearchPrompt(executionPrompt) ? 1 : 4;
      const artifacts = this.getArtifactsForPurpose(decision.purpose ?? 'general', artifactLimit);
      const result = await runtime.run(
        {
          prompt: executionPrompt,
          purpose: decision.purpose,
          preferredMode: decision.preferredMode,
          parentSessionId: this.state.sessionId,
          maxTokens: this.config ? getMaxTokens(this.config) : undefined,
          cwd: process.cwd(),
          isolatedLabel: `route-${decision.preferredMode ?? decision.purpose ?? 'general'}`,
          applyWorkspaceChanges: decision.purpose === 'execution' || decision.purpose === 'design',
          readOnly: !(decision.purpose === 'execution' || decision.purpose === 'design'),
          verificationMode: this.verificationModeForPurpose(decision.purpose),
          contextSnapshot,
          artifacts,
        },
        {
          signal: controller.signal,
          onApiCallStart: async (input) => {
            await this.hookRegistry.emit(
              'beforeApiCall',
              buildDelegationHookContext(input, {
                sessionId: this.state.sessionId,
              }),
            );
          },
          onApiCallComplete: async (input) => {
            await this.hookRegistry.emit(
              'afterApiCall',
              buildDelegationHookContext(input, {
                sessionId: this.state.sessionId,
              }),
            );
          },
          onText: (delta) => {
            if (!delta) {
              return;
            }

            const current = this.state.messages.find((message) => message.id === assistantMessage.id)?.content ?? '';
            this.updateMessage(assistantMessage.id, current + delta);
            this.updateAgentActivity({
              id: routeActivityId,
              label: formatModeWorkerLabel(decision.preferredMode ?? null, decision.purpose ?? 'general'),
              status: 'running',
              mode: decision.preferredMode ?? null,
              purpose: decision.purpose ?? 'general',
              detail: previewText(delta, 64),
            });
          },
          onToolState: (states) => {
            this.applyToolStates(assistantMessage.id, states);
            const activeTool = states.find((state) => state.status === 'running') ?? states[states.length - 1];
            if (activeTool) {
              this.updateAgentActivity({
                id: routeActivityId,
                label: formatModeWorkerLabel(decision.preferredMode ?? null, decision.purpose ?? 'general'),
                status: 'running',
                mode: decision.preferredMode ?? null,
                purpose: decision.purpose ?? 'general',
                detail: `${activeTool.name} ${activeTool.status}`,
              });
            }
          },
          onVerificationState: (state) => {
            this.updateAgentActivity({
              id: routeActivityId,
              label: formatModeWorkerLabel(decision.preferredMode ?? null, decision.purpose ?? 'general'),
              status:
                state.status === 'running'
                  ? 'verifying'
                  : state.status === 'passed' || state.status === 'skipped'
                    ? 'done'
                    : 'error',
              mode: decision.preferredMode ?? null,
              purpose: decision.purpose ?? 'general',
              detail: state.summary ?? null,
            });
          },
          onExecutionState: (detail) => {
            this.updateAgentActivity({
              id: routeActivityId,
              label: formatModeWorkerLabel(decision.preferredMode ?? null, decision.purpose ?? 'general'),
              status: 'queued',
              mode: decision.preferredMode ?? null,
              purpose: decision.purpose ?? 'general',
              detail,
            });
          },
        },
      );

      const finalText = result.text.trim() || `[${HARNESS_MODES[result.mode].label}] no output`;
      this.finishMessage(assistantMessage.id, finalText);
      this.rememberDelegationArtifact({
        purpose: result.purpose,
        requestedKind: result.requestedArtifactKind,
        mode: result.mode,
        text: finalText,
        task: executionPrompt,
        verification: result.verification,
        workspaceApply: result.workspaceApply
          ? {
              applied: result.workspaceApply.applied,
              empty: result.workspaceApply.empty,
              summary: result.workspaceApply.summary,
              error: result.workspaceApply.error,
              path: result.workspace?.path ?? null,
            }
          : null,
      });
      if (result.workspaceApply?.attempted) {
        if (result.workspaceApply.applied) {
          this.appendSystemMessage(`[apply] ${result.workspaceApply.summary}`);
        } else if (!result.workspaceApply.empty) {
          this.appendSystemMessage(
            `[apply] failed to land isolated changes${result.workspaceApply.error ? ` · ${result.workspaceApply.error}` : ''}`,
          );
        }
      }
      this.setWorkspaceState(result.workspace ?? null);
      if (result.verification) {
        this.setVerificationState({
          status: result.verification.status,
          summary: result.verification.summary,
          cwd: result.verification.cwd,
        });
        if (result.verification.status !== 'skipped') {
          this.appendSystemMessage(`[verify] ${result.verification.summary}`);
        }
      }
      await this.finalizeVerificationRecovery({
        reason: decision.reason,
        purpose: result.purpose ?? 'general',
        output: finalText,
        mode: result.mode,
        verification: result.verification,
        appliedToBase:
          result.workspaceApply?.attempted === true
            ? result.workspaceApply.applied
            : true,
      });
      this.updateAgentActivity({
        id: routeActivityId,
        label: formatModeWorkerLabel(result.mode, result.purpose),
        status: 'done',
        mode: result.mode,
        purpose: result.purpose,
        detail: result.verification?.summary ?? previewText(finalText, 64),
        workspacePath: result.workspace?.path ?? null,
      });

      await this.hookRegistry.emit('afterResponse', {
        provider: result.provider,
        model: result.model,
        sessionId: this.state.sessionId,
        remoteSessionId: result.remoteSessionId ?? null,
        requestMode: 'full',
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
      });

      if (this.sessionManager && this.state.sessionId) {
        await this.sessionManager.append(this.state.sessionId, {
          type: 'message',
          timestamp: new Date().toISOString(),
          data: {
            user: userMessage.content,
            assistant: finalText,
            mode: result.mode,
            provider: result.provider,
            model: result.model,
            requestMode: 'delegate',
            purpose: result.purpose,
            autoRoute: decision.reason,
            remoteSessionId: result.remoteSessionId,
            workspacePath: result.workspace?.path,
            verification: result.verification
              ? {
                  status: result.verification.status,
                  summary: result.verification.summary,
                }
              : undefined,
            inputTokens: result.usage.input,
            outputTokens: result.usage.output,
          },
        });
      }
      await this.maybeScheduleVerificationFollowup({
        purpose: result.purpose ?? 'general',
        userPrompt: userMessage.content,
        assistantOutput: finalText,
        verification: result.verification,
      });
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        this.updateAgentActivity({
          id: routeActivityId,
          label: formatModeWorkerLabel(decision.preferredMode ?? null, decision.purpose ?? 'general'),
          status: 'error',
          mode: decision.preferredMode ?? null,
          purpose: decision.purpose ?? 'general',
          detail: serializeError(error),
        });
        await this.hookRegistry.emit('onError', {
          provider: this.getCurrentProvider(),
          model: this.getCurrentModel(),
          sessionId: this.state.sessionId,
          operation: 'delegate',
          message: serializeError(error),
        });
        this.finishMessage(assistantMessage.id, toErrorMessage(error));
      } else {
        this.updateAgentActivity({
          id: routeActivityId,
          label: formatModeWorkerLabel(decision.preferredMode ?? null, decision.purpose ?? 'general'),
          status: 'error',
          mode: decision.preferredMode ?? null,
          purpose: decision.purpose ?? 'general',
          detail: 'request aborted',
        });
        this.finishMessage(assistantMessage.id, '[request aborted]');
      }
    } finally {
      this.state.loading = false;
      this.state.loadingLabel = '';
      this.state.loadingSince = null;
      this.state.requestEstimate = null;
      this.abortController = null;
      this.activeAssistantMessageId = null;
      this.activeOperation = null;
      this.scheduleStatePush();
    }
  }

  private async consumeStream(
    stream: AsyncGenerator<StreamEvent>,
    context: {
      assistantMessageId: string;
      apiMessages: ApiMessage[];
      currentText: string;
      requestInputTokens: number;
      requestOutputTokens: number;
      requestUncachedInputTokens: number;
      requestCachedInputTokens: number;
      requestCacheWriteInputTokens: number;
      signal: AbortSignal;
      onSession?: (sessionId: string) => void;
    },
  ): Promise<{
    fullText: string;
    inputTokens: number;
    outputTokens: number;
    uncachedInputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    done: boolean;
    continueWithTools: boolean;
  }> {
    let fullText = context.currentText;
    let inputTokens = context.requestInputTokens;
    let outputTokens = context.requestOutputTokens;
    let uncachedInputTokens = context.requestUncachedInputTokens;
    let cachedInputTokens = context.requestCachedInputTokens;
    let cacheWriteInputTokens = context.requestCacheWriteInputTokens;
    let done = false;
    let continueWithTools = false;

    for await (const event of stream) {
      if (context.signal.aborted) {
        break;
      }

      if (event.type === 'text') {
        fullText += event.text ?? '';
        this.updateMessage(context.assistantMessageId, fullText);
        continue;
      }

      if (event.type === 'session' && event.sessionId) {
        context.onSession?.(event.sessionId);
        continue;
      }

      if (event.type === 'tool_use') {
        const toolUseBlocks = event.toolUseBlocks ?? [];
        fullText = event.textSoFar ?? fullText;

        const usage = event.usage;
        if (usage) {
          inputTokens += usage.input;
          outputTokens += usage.output;
          uncachedInputTokens += usage.uncachedInput ?? usage.input;
          cachedInputTokens += usage.cachedInput ?? 0;
          cacheWriteInputTokens += usage.cacheWriteInput ?? 0;
        }

        const toolCalls: NativeToolCallState[] = toolUseBlocks.map((block) => ({
          id: block.id,
          name: block.name,
          args: JSON.stringify(block.input),
          summary: summarizeToolInput(block.name, block.input),
          status: 'running',
        }));

        this.updateMessage(context.assistantMessageId, fullText, toolCalls);

        const results = await this.executeToolCalls(toolUseBlocks as ToolUseBlock[], {
          assistantMessageId: context.assistantMessageId,
          signal: context.signal,
        });

        context.apiMessages.push({
          role: 'assistant',
          content: toAssistantToolUseContent(fullText, toolUseBlocks),
        });
        context.apiMessages.push({
          role: 'user',
          content: toToolResultContent(results),
        });

        continueWithTools = true;
        break;
      }

      if (event.type === 'tool_state') {
        this.applyToolStates(context.assistantMessageId, event.toolStates ?? []);
        continue;
      }

      if (event.type === 'done') {
        if (event.usage) {
          inputTokens += event.usage.input;
          outputTokens += event.usage.output;
          uncachedInputTokens += event.usage.uncachedInput ?? event.usage.input;
          cachedInputTokens += event.usage.cachedInput ?? 0;
          cacheWriteInputTokens += event.usage.cacheWriteInput ?? 0;
        }

        fullText = event.fullText ?? fullText;
        this.finishMessage(context.assistantMessageId, fullText);
        done = true;
        break;
      }

      if (event.type === 'error') {
        throw event.error ?? new Error('Streaming request failed.');
      }
    }

    return {
      fullText,
      inputTokens,
      outputTokens,
      uncachedInputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      done,
      continueWithTools,
    };
  }

  private classifyToolRisk(name: string, input: Record<string, unknown>): ToolRiskAssessment {
    return analyzeToolRisk(name, input);
  }

  private getConfiguredToolPolicy(name: string): ToolPolicy {
    const policies = this.config?.tools.policies ?? {};
    if (isToolPolicy(policies[name])) {
      return policies[name] as ToolPolicy;
    }

    for (const [pattern, value] of Object.entries(policies)) {
      if (!isToolPolicy(value) || !pattern.endsWith('*')) {
        continue;
      }
      const prefix = pattern.slice(0, -1);
      if (prefix && name.startsWith(prefix)) {
        return value;
      }
    }

    return 'inherit';
  }

  private async setConfiguredToolPolicy(name: string, policy: ToolPolicy): Promise<void> {
    if (policy === 'inherit') {
      await deleteDduduConfigValue(process.cwd(), `tools.policies.${name}`);
    } else {
      await setDduduConfigValue(process.cwd(), `tools.policies.${name}`, policy);
    }

    this.config = await loadConfig();
    this.scheduleStatePush();
  }

  private async setStringListConfigValue(
    keyPath: string,
    nextValues: string[],
  ): Promise<void> {
    await setDduduConfigValue(process.cwd(), keyPath, nextValues);
    this.config = await loadConfig();
    this.scheduleStatePush();
  }

  private async addStringListConfigValue(
    keyPath: string,
    rawValue: string,
  ): Promise<void> {
    const value = rawValue.trim();
    if (!value) {
      return;
    }

    const current = keyPath === 'tools.network.allowed_hosts'
      ? this.config?.tools.network.allowed_hosts ?? []
      : keyPath === 'tools.network.denied_hosts'
        ? this.config?.tools.network.denied_hosts ?? []
        : keyPath === 'tools.secrets.protected_paths'
          ? this.config?.tools.secrets.protected_paths ?? []
          : this.config?.tools.secrets.protected_env ?? [];

    if (current.includes(value)) {
      return;
    }

    await this.setStringListConfigValue(keyPath, [...current, value]);
  }

  private async removeStringListConfigValue(
    keyPath: string,
    rawValue: string,
  ): Promise<void> {
    const value = rawValue.trim();
    const current = keyPath === 'tools.network.allowed_hosts'
      ? this.config?.tools.network.allowed_hosts ?? []
      : keyPath === 'tools.network.denied_hosts'
        ? this.config?.tools.network.denied_hosts ?? []
        : keyPath === 'tools.secrets.protected_paths'
          ? this.config?.tools.secrets.protected_paths ?? []
          : this.config?.tools.secrets.protected_env ?? [];

    await this.setStringListConfigValue(
      keyPath,
      current.filter((entry) => entry !== value),
    );
  }

  private async setMcpServerTrust(name: string, trust: TrustTier): Promise<void> {
    await setDduduConfigValue(process.cwd(), `mcp.servers.${name}.trust`, trust);
    await this.reloadMcpRuntime();
  }

  private async authorizeToolExecution(
    block: ToolUseBlock,
    toolContext: ToolContext,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const input = typeof block.input === 'object' && block.input !== null ? block.input as Record<string, unknown> : {};
    const toolsConfig = this.config?.tools ?? {
      permission: 'auto',
      toolbox_dirs: [],
      policies: {},
      network: {
        allowed_hosts: [],
        denied_hosts: [],
        ask_on_new_host: false,
      },
      secrets: {
        protected_paths: [],
        protected_env: [],
      },
    };
    const mcpConfig = this.config?.mcp ?? { servers: {} };
    const baseRisk = this.classifyToolRisk(block.name, input);
    const trustBoundary = analyzeTrustBoundary(
      process.cwd(),
      block.name,
      input,
      toolsConfig,
      mcpConfig,
    );
    const risk: ToolRiskAssessment = {
      level: baseRisk.level,
      concerns: Array.from(new Set([...baseRisk.concerns, ...trustBoundary.concerns])),
      hardBlockReason: baseRisk.hardBlockReason ?? trustBoundary.hardBlockReason,
    };
    const policy = this.getConfiguredToolPolicy(block.name);

    if (risk.hardBlockReason) {
      return { allowed: false, reason: risk.hardBlockReason };
    }

    if (policy === 'deny') {
      return { allowed: false, reason: `Blocked ${block.name}: tool policy is deny.` };
    }

    if (this.permissionProfile === 'plan') {
      if (risk.level === 'read') {
        if (!trustBoundary.requiresApproval && policy !== 'ask') {
          return { allowed: true };
        }
      } else {
        return { allowed: false, reason: `Blocked ${block.name}: current permission profile is plan (read-only).` };
      }
    }

    if (policy === 'allow' && !trustBoundary.requiresApproval) {
      return { allowed: true };
    }

    const needsApproval =
      policy === 'ask'
      || trustBoundary.requiresApproval
      || shouldPromptForRisk(this.permissionProfile, risk);

    if (this.permissionProfile === 'permissionless' && !needsApproval) {
      return { allowed: true };
    }

    if (this.permissionProfile === 'ask' && risk.level === 'read' && !needsApproval) {
      return { allowed: true };
    }

    if (!needsApproval) {
      return { allowed: true };
    }

    if (policy === 'ask' || trustBoundary.requiresApproval || shouldPromptForRisk(this.permissionProfile, risk)) {
      const summary = summarizeToolInput(block.name, input);
      const detail = trustBoundary.detail ? ` · ${trustBoundary.detail}` : '';
      const answer = toolContext.askUser
        ? await toolContext.askUser(
          `Allow ${summary}? (${formatRiskConcerns(risk)}${detail})`,
          ['Allow once', `Deny (${this.permissionProfile})`],
        )
        : 'Deny';

      return {
        allowed: answer.toLowerCase().includes('allow'),
        reason: `Denied ${block.name}: approval was not granted.`,
      };
    }

    return {
      allowed: true,
    };
  }

  private async executeToolCalls(
    blocks: ToolUseBlock[],
    context: { assistantMessageId: string; signal: AbortSignal },
  ): Promise<ToolResultBlock[]> {
    const registry = this.toolRegistry;
    if (!registry) {
      return blocks.map((block) => ({
        type: 'tool_result',
        tool_use_id: block.id,
        content: `Unknown tool registry; cannot execute ${block.name}`,
        is_error: true,
      }));
    }

    const anthropicAuth = this.availableProviders.get('anthropic') ?? this.availableProviders.get('claude');
    const results: Array<ToolResultBlock | undefined> = new Array(blocks.length);
    const preparedExecutions: Array<{
      index: number;
      block: ToolUseBlock;
      tool: Tool;
      syntheticToolLabel: string;
      toolContext: ToolContext;
      toolStartedAt: number;
      toolActivitySnapshots: Map<string, {
        id: string;
        label: string;
        mode: NamedMode | null;
        purpose: string | null;
        status: AgentActivityState['status'];
        detail: string | null;
        workspacePath: string | null;
        updatedAt: number;
      }>;
      publishToolHeartbeat: (force?: boolean) => void;
      syncSyntheticActivity: (
        status: AgentActivityState['status'],
        detail?: string | null,
        workspacePath?: string | null,
      ) => void;
      parallelSafe: boolean;
    }> = [];

    for (const [index, block] of blocks.entries()) {
      const tool = registry.get(block.name);
      if (!tool) {
        this.setToolStatus(context.assistantMessageId, block.id, 'error', `Unknown tool: ${block.name}`);
        results[index] = {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Unknown tool: ${block.name}`,
          is_error: true,
        };
        continue;
      }

      let progress = '';
      const toolActivitySnapshots = new Map<string, {
        id: string;
        label: string;
        mode: NamedMode | null;
        purpose: string | null;
        status: AgentActivityState['status'];
        detail: string | null;
        workspacePath: string | null;
        updatedAt: number;
      }>();
      const toolStartedAt = Date.now();
      let lastVisibleToolUpdateAt = toolStartedAt;
      const syntheticToolLabel = previewText(summarizeToolInput(block.name, block.input), 56) || block.name;
      const syntheticToolActivityId = isParallelSafeToolCall(block.name)
        ? buildSyntheticToolActivityId(context.assistantMessageId, block.id)
        : null;
      const syncSyntheticActivity = (
        status: AgentActivityState['status'],
        detail?: string | null,
        workspacePath?: string | null,
      ): void => {
        if (!syntheticToolActivityId) {
          return;
        }

        const snapshot = {
          id: syntheticToolActivityId,
          label: syntheticToolLabel,
          status,
          mode: null,
          purpose: 'tool',
          detail: detail ?? null,
          workspacePath: workspacePath ?? null,
          updatedAt: Date.now(),
        };
        toolActivitySnapshots.set(syntheticToolActivityId, snapshot);
        this.updateAgentActivity(snapshot);
      };
      const publishToolHeartbeat = (force: boolean = false): void => {
        if (toolActivitySnapshots.size === 0) {
          return;
        }

        const now = Date.now();
        if (!force && now - lastVisibleToolUpdateAt < 10_000) {
          return;
        }

        this.setToolStatus(
          context.assistantMessageId,
          block.id,
          'running',
          summarizeToolResult(
            formatAgentActivityHeartbeat({
              label: syntheticToolLabel,
              elapsedMs: now - toolStartedAt,
              activities: Array.from(toolActivitySnapshots.values()),
            }),
          ),
        );
        lastVisibleToolUpdateAt = now;
      };
      const toolContext: ToolContext = {
        cwd: process.cwd(),
        abortSignal: context.signal,
        authToken: anthropicAuth?.token,
        authBaseUrl: process.env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL,
        delegation: this.createDelegationRuntime(),
        sessionId: this.state.sessionId ?? undefined,
        currentMode: this.currentMode,
        permissionProfile: this.permissionProfile,
        setPermissionProfile: async (profile): Promise<void> => {
          await this.setPermissionProfile(profile);
        },
        plan: {
          list: (): PlanItem[] => [...this.todos],
          replace: async (items): Promise<void> => {
            await this.replacePlan(items);
          },
          add: async (step, status, owner): Promise<void> => {
            await this.addPlanItem(step, status, owner);
          },
          update: async (stepOrId, updates): Promise<void> => {
            await this.updatePlanItem(stepOrId, updates);
          },
          clear: async (): Promise<void> => {
            await this.clearPlan();
          },
        },
        askUser: (question: string, options?: string[]): Promise<string> => {
          return new Promise<string>((resolve, reject) => {
            this.pendingAskUser = { resolve, reject };
            this.state.askUser = {
              question,
              options: options ?? [],
            };
            this.scheduleStatePush();
          });
        },
        onProgress: (text: string): void => {
          progress += text;
          lastVisibleToolUpdateAt = Date.now();
          syncSyntheticActivity('running', summarizeToolResult(progress));
          this.setToolStatus(
            context.assistantMessageId,
            block.id,
            'running',
            summarizeToolResult(progress),
          );
        },
        onAgentActivity: (activity): void => {
          toolActivitySnapshots.set(activity.id, {
            id: activity.id,
            label: activity.label,
            status: activity.status,
            mode: activity.mode ?? null,
            purpose: activity.purpose ?? null,
            detail: activity.detail ?? null,
            workspacePath: activity.workspacePath ?? null,
            updatedAt: Date.now(),
          });
          this.updateAgentActivity({
            id: activity.id,
            label: activity.label,
            status: activity.status,
            mode: activity.mode ?? null,
            purpose: activity.purpose ?? null,
            detail: activity.detail ?? null,
            workspacePath: activity.workspacePath ?? null,
          });
          publishToolHeartbeat(true);
        },
        contextSnapshot: async (prompt: string, purpose?: string): Promise<string> => {
          return this.buildPromptContextSnapshot(prompt, purpose as DelegationPurpose | 'general' | undefined);
        },
        artifacts: (purpose?: string, limit?: number): WorkflowArtifact[] => {
          return this.getArtifactsForPurpose(
            (purpose as DelegationPurpose | 'general' | undefined) ?? 'general',
            limit ?? 4,
          );
        },
        lsp: this.lspManager,
      };

      const authorization = await this.authorizeToolExecution(block, toolContext);
      if (!authorization.allowed) {
        const message = authorization.reason ?? `Tool blocked by permission profile ${this.permissionProfile}`;
        syncSyntheticActivity('error', message);
        this.setToolStatus(context.assistantMessageId, block.id, 'error', summarizeToolResult(message));
        results[index] = {
          type: 'tool_result',
          tool_use_id: block.id,
          content: message,
          is_error: true,
        };
        continue;
      }

      preparedExecutions.push({
        index,
        block,
        tool,
        syntheticToolLabel,
        toolContext,
        toolStartedAt,
        toolActivitySnapshots,
        publishToolHeartbeat,
        syncSyntheticActivity,
        parallelSafe: isParallelSafeToolCall(block.name),
      });
    }

    const pendingParallel: Array<Promise<void>> = [];
    const flushParallel = async (): Promise<void> => {
      if (pendingParallel.length === 0) {
        return;
      }
      await Promise.all(pendingParallel);
      pendingParallel.length = 0;
    };

    const runPreparedExecution = async (
      prepared: (typeof preparedExecutions)[number],
    ): Promise<void> => {
      const { index, block, tool, syntheticToolLabel, toolContext, publishToolHeartbeat, syncSyntheticActivity } = prepared;
      syncSyntheticActivity('running', syntheticToolLabel);
      this.setToolStatus(
        context.assistantMessageId,
        block.id,
        'running',
        summarizeToolResult(syntheticToolLabel),
      );
      const toolHeartbeatTimer = setInterval(() => {
        if (context.signal.aborted) {
          return;
        }
        publishToolHeartbeat(false);
      }, 5_000);

      try {
        await this.hookRegistry.emit('beforeToolCall', {
          tool: block.name,
          input: block.input,
          sessionId: this.state.sessionId,
        });
        const result = await tool.execute(block.input, toolContext);
        let workspacePath: string | null = null;
        if (result.metadata && typeof result.metadata === 'object') {
          const metadata = result.metadata as Record<string, unknown>;
          if (typeof metadata.workspacePath === 'string' && metadata.workspacePath.trim()) {
            workspacePath = metadata.workspacePath;
            this.state.workspace = {
              label: block.name,
              path: metadata.workspacePath,
              kind: typeof metadata.workspaceKind === 'string' ? metadata.workspaceKind : 'git-worktree',
            };
          }
          const verification = metadata.verification;
          if (typeof verification === 'object' && verification !== null) {
            const record = verification as Record<string, unknown>;
            const status = record.status;
            const summary = record.summary;
            const cwd = record.cwd;
            if (
              (status === 'running' || status === 'passed' || status === 'failed' || status === 'skipped') &&
              (summary === null || typeof summary === 'string') &&
              (cwd === null || typeof cwd === 'string')
            ) {
              this.state.verification = {
                status,
                summary,
                cwd,
              };
            }
          }
        }
        syncSyntheticActivity(
          result.isError ? 'error' : 'done',
          summarizeToolResult(result.output),
          workspacePath,
        );
        this.setToolStatus(
          context.assistantMessageId,
          block.id,
          result.isError ? 'error' : 'done',
          summarizeToolResult(result.output),
        );
        await this.hookRegistry.emit('afterToolCall', {
          tool: block.name,
          input: block.input,
          output: result.output,
          isError: result.isError ?? false,
          sessionId: this.state.sessionId,
        });

        results[index] = {
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.output,
          is_error: result.isError || undefined,
        };
      } catch (error: unknown) {
        const message = serializeError(error);
        syncSyntheticActivity('error', message);
        this.setToolStatus(
          context.assistantMessageId,
          block.id,
          'error',
          summarizeToolResult(message),
        );
        await this.hookRegistry.emit('onError', {
          tool: block.name,
          input: block.input,
          error: message,
          sessionId: this.state.sessionId,
        });
        results[index] = {
          type: 'tool_result',
          tool_use_id: block.id,
          content: message,
          is_error: true,
        };
      } finally {
        clearInterval(toolHeartbeatTimer);
      }
    };

    for (const prepared of preparedExecutions) {
      if (prepared.parallelSafe) {
        pendingParallel.push(runPreparedExecution(prepared));
      } else {
        await flushParallel();
        await runPreparedExecution(prepared);
      }
    }

    await flushParallel();
    return results.filter((item): item is ToolResultBlock => Boolean(item));
  }

  private async refreshSystemPrompt(): Promise<void> {
    const runtime = this.getResolvedModeRuntime();
    const mode = runtime.mode;
    const model = runtime.model;
    const provider = runtime.provider;
    const modeConfig = HARNESS_MODES[mode] ?? HARNESS_MODES.jennie;
    const cwd = process.cwd();
    const projectName = basename(cwd) || 'unknown-project';
    const loadedSkills = Array.from(this.loadedSkills.values());

    try {
      const promptContext = {
        model,
        provider,
        cwd,
        projectName,
        version: PROMPT_VERSION,
        timestamp: new Date().toISOString(),
        rules: [],
        skills: loadedSkills.map((skill) => skill.name),
        userInstructions: modeConfig.promptAddition.trim(),
      };
      let prompt = await loadSystemPrompt(promptContext);
      this.orchestratorPrompt = await loadOrchestratorPrompt(promptContext);

      if (loadedSkills.length > 0) {
        prompt += `\n\n${loadedSkills
          .map(
            (skill) =>
              `<skill name="${skill.name}">\n${skill.content.trim()}\n</skill>`,
          )
          .join('\n\n')}`;
      }

      try {
        const memory = await this.getCachedSelectedMemory(this.getSystemMemoryScopes(mode), 360);
        if (hasMeaningfulMemory(memory)) {
          prompt += `\n\n<stable_memory>\n${memory}\n</stable_memory>`;
        }
      } catch {
        // Memory is optional; keep prompt generation resilient.
      }

      prompt += `\n\n<workflow>\npermission_profile: ${this.permissionProfile}\n${this.buildSlimWorkflowSummary()}\n</workflow>`;
      this.state.contextPreview = null;

      this.systemPrompt = prompt;
    } catch {
      this.systemPrompt = buildFallbackSystemPrompt(mode, model, provider);
      this.orchestratorPrompt = null;
      this.state.contextPreview = null;
    }

    this.syncUsageState();
  }

  private getSystemMemoryScopes(mode: NamedMode = this.currentMode): MemoryScope[] {
    if (mode === 'lisa') {
      return ['procedural', 'working'];
    }

    if (mode === 'rosé') {
      return ['project', 'semantic', 'procedural'];
    }

    if (mode === 'jisoo') {
      return ['project', 'semantic'];
    }

    return ['project', 'procedural', 'semantic'];
  }

  private getRequestMemoryScopes(purpose: DelegationPurpose | 'general'): MemoryScope[] {
    switch (purpose) {
      case 'execution':
        return ['working', 'semantic', 'procedural'];
      case 'planning':
        return ['project', 'episodic', 'semantic'];
      case 'research':
        return ['episodic', 'semantic', 'project'];
      case 'review':
        return ['semantic', 'procedural', 'working'];
      case 'design':
        return ['project', 'semantic', 'procedural'];
      case 'oracle':
        return ['semantic', 'procedural'];
      default:
        return ['working', 'semantic'];
    }
  }

  private buildSlimWorkflowSummary(): string {
    const activeItems = this.todos
      .filter((item) => item.status !== 'completed')
      .slice(0, 3)
      .map((item) => `plan_item: [${item.status}] ${previewText(item.step, 140)}`);

    return [
      `mode: ${HARNESS_MODES[this.currentMode].label}`,
      activeItems.length > 0 ? activeItems.join('\n') : 'plan_item: none',
    ].join('\n');
  }

  private buildWorkflowStateSource(): WorkflowStateSource {
    return {
      currentMode: this.currentMode,
      selectedModels: this.selectedModels,
      permissionProfile: this.permissionProfile,
      todos: this.todos,
      remoteSessions: this.remoteSessions.values(),
      artifacts: this.artifacts,
      queuedPrompts: this.queuedPrompts,
      backgroundJobs: this.backgroundJobs,
    };
  }

  private getWorkflowSnapshot(): WorkflowStateSnapshot {
    return this.workflowStateStore.buildSnapshot(this.buildWorkflowStateSource());
  }

  private async persistWorkflowState(
    reason: string,
    sessionId: string = this.state.sessionId ?? '',
    snapshot: WorkflowStateSnapshot = this.getWorkflowSnapshot(),
  ): Promise<void> {
    await this.workflowStateStore.persist(reason, sessionId, snapshot);
  }

  private async setPermissionProfile(profile: PermissionProfile): Promise<void> {
    this.permissionProfile = profile;
    if (profile !== 'permissionless') {
      this.lastSafePermissionProfile = profile;
    }
    this.state.permissionProfile = profile;
    this.state.playingWithFire = profile === 'permissionless';
    await this.refreshSystemPrompt();
    this.scheduleStatePush();
    void this.persistWorkflowState('permission_profile');
  }

  private formatPlanSummary(): string {
    if (this.todos.length === 0) {
      return 'plan: none';
    }

    return [
      'plan:',
      ...this.todos.map((item, index) => `${index + 1}. [${item.status}] ${item.step}${item.owner ? ` · ${item.owner}` : ''}`),
    ].join('\n');
  }

  private async replacePlan(items: PlanItem[]): Promise<void> {
    this.todos = items.map((item) => ({ ...item }));
    this.state.todos = this.todos.map((item) => ({ ...item }));
    await this.refreshSystemPrompt();
    this.scheduleStatePush();
    void this.persistWorkflowState('plan_replace');
  }

  private async addPlanItem(
    step: string,
    status: PlanItemStatus = 'pending',
    owner?: string,
  ): Promise<void> {
    this.todos.push({
      id: randomUUID(),
      step: step.trim(),
      status,
      owner,
      updatedAt: new Date().toISOString(),
    });
    this.state.todos = this.todos.map((item) => ({ ...item }));
    await this.refreshSystemPrompt();
    this.scheduleStatePush();
    void this.persistWorkflowState('plan_add');
  }

  private async updatePlanItem(
    stepOrId: string,
    updates: { status?: PlanItemStatus; owner?: string },
  ): Promise<void> {
    const match = this.todos.find((item) => item.id === stepOrId || item.step === stepOrId);
    if (!match) {
      throw new Error(`Plan item not found: ${stepOrId}`);
    }

    if (updates.status) {
      match.status = updates.status;
    }
    if (updates.owner !== undefined) {
      match.owner = updates.owner;
    }
    match.updatedAt = new Date().toISOString();
    this.state.todos = this.todos.map((item) => ({ ...item }));
    await this.refreshSystemPrompt();
    this.scheduleStatePush();
    void this.persistWorkflowState('plan_update');
  }

  private async clearPlan(): Promise<void> {
    this.todos = [];
    this.state.todos = [];
    await this.refreshSystemPrompt();
    this.scheduleStatePush();
    void this.persistWorkflowState('plan_clear');
  }

  private getSessionArtifactDirectory(sessionId: string = this.state.sessionId ?? ''): string | null {
    if (!this.sessionManager || !sessionId) {
      return null;
    }

    return this.sessionManager.getArtifactDirectory(sessionId);
  }

  private async restoreEpistemicState(): Promise<void> {
    const artifactDir = this.getSessionArtifactDirectory();
    if (!artifactDir) {
      return;
    }

    await this.epistemicState.load(artifactDir);
  }

  private async resumeRequestedSession(): Promise<boolean> {
    const requestedSessionId = process.env.DDUDU_RESUME_SESSION_ID?.trim();
    if (!requestedSessionId || !this.sessionManager) {
      return false;
    }

    try {
      const loaded = await this.sessionManager.load(requestedSessionId);
      this.applyRestoredSession(this.workflowStateStore.restoreSession(loaded, {
        fallbackMode: this.currentMode,
        fallbackSelectedModels: this.selectedModels,
        fallbackPermissionProfile: this.permissionProfile,
        normalizePermissionProfile,
      }));
      return true;
    } catch (error: unknown) {
      this.appendSystemMessage(
        `[session] Failed to resume ${requestedSessionId}: ${serializeError(error)}`,
      );
      return false;
    }
  }

  private applyRestoredSession(restored: ReturnType<WorkflowStateStore['restoreSession']>): void {
    this.currentMode = restored.mode;
    this.state.mode = restored.mode;
    this.remoteSessions.clear();
    this.agentActivities = [];
    this.backgroundJobs = [];
    this.backgroundCoordinator.clearStatusCache();
    this.queuedPrompts = [];
    this.syncAgentActivities();
    this.syncBackgroundJobs();
    this.selectedModels = { ...restored.selectedModels };
    this.permissionProfile = restored.permissionProfile;
    this.lastSafePermissionProfile =
      this.permissionProfile === 'permissionless' ? DEFAULT_PERMISSION_PROFILE : this.permissionProfile;
    this.state.permissionProfile = this.permissionProfile;
    this.state.playingWithFire = this.permissionProfile === 'permissionless';
    this.todos = restored.todos.map((item) => ({ ...item }));
    this.state.todos = this.todos.map((item) => ({ ...item }));
    this.artifacts = restored.artifacts.map((artifact) => ({ ...artifact }));
    this.syncArtifacts();
    this.queuedPrompts = [...restored.queuedPrompts];
    this.state.queuedPrompts = [...this.queuedPrompts];
    this.backgroundJobs = restored.backgroundJobs.map((job) => ({
      ...job,
      status: job.status === 'running' ? 'error' : job.status,
      detail: job.status === 'running' ? 'interrupted by restart' : job.detail,
      checklist: Array.isArray(job.checklist) ? job.checklist.map((item) => ({ ...item })) : [],
      controller: null,
    }));
    this.syncBackgroundJobs();
    for (const remoteSession of restored.remoteSessions) {
      this.remoteSessions.set(remoteSession.provider, { ...remoteSession });
    }

    this.state.sessionId = restored.sessionId;
    this.state.messages = restored.messages;
    this.updateRemoteSessionState();
  }

  private async initializeMcpTools(): Promise<void> {
    if (!this.config || !this.toolRegistry) {
      return;
    }

    const entries = Object.entries(this.config.mcp.servers ?? {}).filter(([, server]) => server.enabled !== false);
    if (entries.length === 0) {
      return;
    }

    const manager = new McpManager();
    for (const [name, config] of entries) {
      const { trust: _trust, ...serverConfig } = config;
      manager.addServer(name, serverConfig as McpServerConfig);
    }

    await manager.connectAll();
    for (const tool of manager.getAllTools()) {
      this.toolRegistry.register(buildMcpTool(manager, tool));
    }

    this.mcpManager = manager;
    this.syncMcpState();
  }

  private async reloadMcpRuntime(): Promise<void> {
    this.config = await loadConfig();
    this.mcpManager?.disconnectAll();
    this.mcpManager = null;
    this.toolRegistry?.removeMatching((name) => name.startsWith('mcp__'));
    await this.initializeMcpTools();
    this.syncMcpState();
    await this.refreshSystemPrompt();
    this.scheduleStatePush();
  }

  private async setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
    if (!this.config?.mcp.servers[name]) {
      throw new Error(`Unknown MCP server: ${name}`);
    }
    await setDduduConfigValue(process.cwd(), `mcp.servers.${name}.enabled`, enabled);
    await this.reloadMcpRuntime();
  }

  private syncMcpState(): void {
    const entries = Object.entries(this.config?.mcp.servers ?? {});
    const connectedServers = this.mcpManager?.getConnectedServers() ?? [];
    const toolCount =
      this.toolRegistry?.list().filter((tool) => tool.name.startsWith('mcp__')).length ?? 0;

    const nextState: NativeMcpState = {
      configuredServers: entries.length,
      connectedServers: connectedServers.length,
      toolCount,
      serverNames: entries.map(([name]) => name),
      connectedNames: [...connectedServers],
    };

    this.state.mcp = nextState;
  }

  private syncLspState(): void {
    const state = this.lspManager.getServerState();
    const nextState: NativeLspState = {
      availableServers: state.available.length,
      connectedServers: state.connected.length,
      serverLabels: state.available.map((server) => server.label),
      connectedLabels: state.connected.map((server) => server.label),
    };

    this.state.lsp = nextState;
  }

  private buildProviderState(): NativeProviderState[] {
    return PROVIDER_NAMES.map((provider) => {
      const auth = this.availableProviders.get(provider);
      return {
        name: provider,
        available: Boolean(auth),
        source: auth?.source,
        tokenType: auth?.tokenType,
      };
    });
  }

  private hasResolvedProvider(provider: HarnessProviderName): boolean {
    const auth = this.availableProviders.get(provider);
    return Boolean(auth && !auth.source.includes(':stale'));
  }

  private getModeBinding(mode: NamedMode = this.currentMode) {
    return resolveModeBinding(mode, (provider) => this.hasResolvedProvider(provider));
  }

  private getResolvedModeRuntime(mode: NamedMode = this.currentMode): {
    mode: NamedMode;
    provider: string;
    model: string;
  } {
    const binding = this.getModeBinding(mode);
    const selected = this.selectedModels[mode];
    const providerName = resolveProviderConfigName(binding.provider);
    const providerConfig = this.config?.providers[providerName];
    const availableModels = providerConfig?.models.map((candidate) => candidate.id) ?? [];

    return {
      mode,
      provider: binding.provider,
      model: selected && availableModels.includes(selected) ? selected : binding.model,
    };
  }

  private getProviderCapabilities(provider: string): ApiClientCapabilities | null {
    const auth = this.availableProviders.get(provider);
    if (!auth) {
      return null;
    }

    return getClientCapabilities(provider, auth.tokenType);
  }

  private getCurrentProvider(): string {
    return this.getResolvedModeRuntime().provider;
  }

  private getCurrentModel(): string {
    return this.getResolvedModeRuntime().model;
  }

  private resolveCurrentProviderModels(): string[] {
    if (!this.config) {
      return [];
    }

    const providerName = resolveProviderConfigName(this.getResolvedModeRuntime().provider);
    const providerConfig = this.config.providers[providerName];
    return providerConfig?.models.map((model) => model.id) ?? [];
  }

  private reconfigureClient(): void {
    const runtime = this.getResolvedModeRuntime();
    const provider = runtime.provider;
    const model = runtime.model;

    this.state.provider = provider;
    this.state.model = model;
    this.state.models = this.resolveCurrentProviderModels();
    this.state.modes = MODE_ORDER.map((modeName) => {
      const modeEntry = HARNESS_MODES[modeName];
      const modeRuntime = this.getResolvedModeRuntime(modeName);
      return {
        name: modeName,
        label: modeEntry.label,
        tagline: modeEntry.tagline,
        provider: modeRuntime.provider,
        model: modeRuntime.model,
        active: modeName === this.currentMode,
      };
    });
    this.tokenCounter.setModel(model);

    const providerAuth = this.availableProviders.get(provider);
    this.state.authType = providerAuth?.tokenType ?? null;
    this.state.authSource = providerAuth?.source ?? null;
    this.state.permissionProfile = this.permissionProfile;
    this.state.playingWithFire = this.permissionProfile === 'permissionless';
    this.state.todos = this.todos.map((item) => ({ ...item }));

    if (providerAuth) {
      this.activeClient = createClient(provider, providerAuth.token, providerAuth.tokenType);
      this.state.error = null;
    } else {
      this.activeClient = null;
      this.state.error = `No auth found for ${provider}. Run: ddudu auth login`;
    }

    this.systemPrompt = buildFallbackSystemPrompt(this.currentMode, model, provider);

    this.updateRemoteSessionState();
    this.syncUsageState();
  }

  private estimateCurrentContextFootprint(): { tokens: number; limit: number; percent: number } {
    const provider = this.getCurrentProvider();
    const capabilities = this.getProviderCapabilities(provider);
    const history = countApiMessageTokens(
      toApiMessages(this.getCanonicalConversationMessages()),
      (text) => this.tokenCounter.countTokens(text),
    );
    const includeTools = capabilities?.supportsApiToolCalls === true;
    const includeSystem = provider === 'anthropic' || !this.isCliBackedProvider(provider);
    const tools =
      includeTools && this.toolRegistry
        ? this.tokenCounter.countTokens(JSON.stringify(formatToolsForApi(this.toolRegistry)))
        : 0;
    const system = includeSystem ? this.tokenCounter.countTokens(this.systemPrompt) : 0;
    const tokens = system + history + tools;
    const limit = this.tokenCounter.getContextLimit();

    return {
      tokens,
      limit,
      percent: limit > 0 ? Math.min(tokens / limit, 1) : 0,
    };
  }

  private syncUsageState(): void {
    const context = this.estimateCurrentContextFootprint();
    this.state.contextPercent = context.percent;
    this.state.contextTokens = context.tokens;
    this.state.contextLimit = context.limit;
  }

  private getContextProfile(provider: string = this.getCurrentProvider(), model: string = this.getCurrentModel()): ContextProfile {
    const triggerRatio = this.config?.compaction.trigger ?? 0.8;
    return deriveContextProfile({
      provider,
      model,
      providerWindowTokens: this.tokenCounter.getContextLimitFor(model),
      cliBacked: this.isCliBackedProvider(provider),
      triggerRatio,
    });
  }

  private getCompactionBuildOptions(provider: string = this.getCurrentProvider()): CompactionBuildOptions {
    const profile = this.getContextProfile(provider);
    return {
      assistantChars: profile.assistantChars,
      userChars: profile.userChars,
      systemChars: profile.systemChars,
      toolResultChars: profile.toolResultChars,
      maxToolCallsPerMessage: profile.maxToolCallsPerMessage,
    };
  }

  private createDelegationRuntime(): DelegationRuntime {
    return new DelegationRuntime({
      cwd: process.cwd(),
      availableProviders: this.availableProviders,
      sessionManager: this.sessionManager,
      worktreeManager: this.worktreeManager,
      executionSchedulerConfig: {
        providerBudgets: this.config?.agent.provider_budgets,
        maxParallelWrites: this.config?.agent.max_parallel_writes,
        pollMs: this.config?.agent.scheduler_poll_ms,
      },
      resolveModel: (mode: NamedMode): string => this.getResolvedModeRuntime(mode).model,
    });
  }

  private async maybeAutoCompact(nextUserPrompt: string): Promise<void> {
    const profile = this.getContextProfile();
    const projectedTokens =
      this.estimateCurrentContextFootprint().tokens + this.tokenCounter.countTokens(nextUserPrompt);
    if (projectedTokens < profile.autoCompactAtTokens) {
      return;
    }

    if (this.getCanonicalConversationCount() <= Math.max(4, (this.config?.compaction.preserve_recent_turns ?? 5) * 2)) {
      return;
    }

    await this.compactContext(
      `Auto compacted canonical session at ${projectedTokens.toLocaleString()} tokens to stay within the working set.`,
      'Auto-compact canonical context before the next request.',
    );
  }

  private estimateRequestForPlan(plan: RequestPlan): NativeRequestEstimateState {
    const provider = this.getCurrentProvider();
    const capabilities = this.getProviderCapabilities(provider);
    const includeTools = capabilities?.supportsApiToolCalls === true;
    const includeSystem =
      plan.mode === 'full' ||
      provider === 'anthropic' ||
      !this.isCliBackedProvider(provider);

    const totalMessages = countApiMessageTokens(plan.apiMessages, (text) =>
      this.tokenCounter.countTokens(text),
    );
    const promptTokens = this.tokenCounter.countTokens(
      typeof plan.apiMessages[plan.apiMessages.length - 1]?.content === 'string'
        ? (plan.apiMessages[plan.apiMessages.length - 1]?.content as string)
        : JSON.stringify(plan.apiMessages[plan.apiMessages.length - 1]?.content ?? ''),
    );
    const history = Math.max(0, totalMessages - promptTokens);
    const tools = includeTools && this.toolRegistry
      ? this.tokenCounter.countTokens(JSON.stringify(formatToolsForApi(this.toolRegistry)))
      : 0;
    const system = includeSystem ? this.tokenCounter.countTokens(this.systemPrompt) : 0;

    return createRequestEstimate({
      system,
      history,
      tools,
      prompt: promptTokens,
      mode: plan.mode,
      note: plan.note ?? undefined,
    });
  }

  private formatConfigSummary(): string {
    const modeEntry = HARNESS_MODES[this.currentMode] ?? HARNESS_MODES.jennie;
    const authLabel = this.state.authType ?? 'missing';

    return [
      'Runtime config',
      `mode: ${modeEntry.label} (${modeEntry.tagline})`,
      `provider: ${this.state.provider}`,
      `model: ${this.state.model}`,
      `auth: ${authLabel}`,
      `permissions: ${this.permissionProfile}`,
      `session: ${this.state.sessionId ?? 'none'}`,
      `plan items: ${this.todos.length}`,
      `skills loaded: ${this.loadedSkills.size}`,
      `tools: ${this.toolRegistry?.list().length ?? 0}`,
    ].join('\n');
  }

  private formatDoctorSummary(): string {
    const profile = this.getContextProfile();
    const queue = this.queuedPrompts.length > 0 ? this.queuedPrompts.length.toString() : '0';
    const lspState = this.lspManager.getServerState();

    return [
      'Doctor',
      `provider: ${this.state.provider}`,
      `model: ${this.state.model}`,
      `auth: ${this.state.authType ?? 'missing'}${this.state.authSource ? ` via ${this.state.authSource}` : ''}`,
      `context: ${this.state.contextTokens.toLocaleString()} / ${this.state.contextLimit.toLocaleString()} (${(this.state.contextPercent * 100).toFixed(1)}%)`,
      `working set: ${profile.canonicalWorkingSetTokens.toLocaleString()} · auto compact at ${profile.autoCompactAtTokens.toLocaleString()}`,
      `permissions: ${this.permissionProfile}`,
      `plan items: ${this.todos.length}`,
      `artifacts: ${this.artifacts.length}`,
      `skills loaded: ${this.loadedSkills.size}`,
      `provider sessions: ${this.remoteSessions.size}`,
      `background queue: ${queue}`,
      `background jobs: ${this.backgroundJobs.length}`,
      `lsp: ${lspState.connected.length}/${lspState.available.length} connected`,
    ].join('\n');
  }

  private async formatSessionSummary(): Promise<string> {
    if (!this.sessionManager) {
      return 'Session manager unavailable.';
    }

    try {
      const sessions = await this.sessionManager.list();
      const recent = sessions
        .slice(0, 3)
        .map((session) => {
          const short = session.id.slice(0, 8);
          return `${short} · ${session.entryCount} entries · ${session.updatedAt}`;
        });

      return [
        'Sessions',
        `current: ${this.state.sessionId ?? 'none'}`,
        `remote: ${this.state.remoteSessionId ?? 'none'} (${this.state.remoteSessionCount} total)`,
        `stored: ${sessions.length}`,
        ...Array.from(this.remoteSessions.values())
          .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
          .slice(0, 3)
          .map((session) => {
            return `${session.provider} · ${session.lastModel} · ${session.sessionId.slice(0, 8)} · synced ${session.syncedMessageCount} msgs`;
          }),
        ...(recent.length > 0 ? recent : ['No saved sessions yet.']),
      ].join('\n');
    } catch (error: unknown) {
      return `Session lookup failed: ${serializeError(error)}`;
    }
  }

  private async formatMemorySummary(): Promise<string> {
    try {
      const memory = await loadMemory(process.cwd());
      if (!hasMeaningfulMemory(memory)) {
        return 'Memory is empty.';
      }
      const preview = previewText(memory, 400);
      return preview ? `Memory\n${preview}` : 'Memory is empty.';
    } catch (error: unknown) {
      return `Memory read failed: ${serializeError(error)}`;
    }
  }

  private parseMemoryScope(value: string | undefined): MemoryScope | null {
    if (!value) {
      return null;
    }

    return MEMORY_SCOPES.includes(value as MemoryScope) ? (value as MemoryScope) : null;
  }

  private formatSessionTitle(session: SessionListItem): string {
    return session.title ?? session.preview ?? `session #${session.id.slice(0, 8)}`;
  }

  private formatSessionListItem(session: SessionListItem): string {
    const runtime = [session.provider, session.model].filter((part): part is string => Boolean(part)).join(' · ');
    const updated = session.updatedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
    const parts = [
      this.formatSessionTitle(session),
      runtime || null,
      `${session.entryCount} entries`,
      updated,
      `#${session.id.slice(0, 8)}`,
    ].filter((part): part is string => Boolean(part));
    return parts.join(' · ');
  }

  private resolveSessionReference(
    sessions: SessionListItem[],
    reference: string,
  ): SessionListItem | null {
    const byIndex = Number.parseInt(reference, 10);
    if (Number.isFinite(byIndex) && byIndex >= 1 && byIndex <= sessions.length) {
      return sessions[byIndex - 1] ?? null;
    }

    return sessions.find((session) => session.id === reference || session.id.startsWith(reference)) ?? null;
  }

  private async promptForChoice(question: string, options: string[]): Promise<string> {
    return await new Promise<string>((resolve) => {
      this.pendingAskUser = {
        resolve,
        reject: () => undefined,
      };
      this.state.askUser = {
        question,
        options,
      };
      this.scheduleStatePush();
    });
  }

  private async promptForInput(question: string, options: string[] = []): Promise<string> {
    return this.promptForChoice(question, options);
  }

  private async resumeSessionById(sessionId: string): Promise<void> {
    if (!this.sessionManager) {
      throw new Error('Session manager unavailable.');
    }

    const loaded = await this.sessionManager.load(sessionId);
    this.applyRestoredSession(this.workflowStateStore.restoreSession(loaded, {
      fallbackMode: this.currentMode,
      fallbackSelectedModels: this.selectedModels,
      fallbackPermissionProfile: this.permissionProfile,
      normalizePermissionProfile,
    }));
    this.invalidateDerivedCaches({ briefing: true, promptContext: true });
    await this.refreshSystemPrompt();
    this.reconfigureClient();
    await this.pollBackgroundJobs();
    this.scheduleStatePush();
  }

  private async runSessionCommand(args: string[]): Promise<string> {
    const command = args[0]?.trim().toLowerCase() ?? '';
    if (!command || command === 'status') {
      return this.formatSessionSummary();
    }

    if (!this.sessionManager) {
      return 'Session manager unavailable.';
    }

    if (command === 'list') {
      const sessions = await this.sessionManager.list();
      if (sessions.length === 0) {
        return 'Sessions: none';
      }
      return [
        'Sessions',
        ...sessions.slice(0, 12).map((session, index) =>
          `${index + 1}. ${this.formatSessionListItem(session)}`),
      ].join('\n');
    }

    if (command === 'last') {
      const sessions = await this.sessionManager.list();
      const latest = sessions[0];
      if (!latest) {
        return 'No saved sessions yet.';
      }
      await this.resumeSessionById(latest.id);
      return `Resumed ${this.formatSessionTitle(latest)}.`;
    }

    if (command === 'pick') {
      const sessions = await this.sessionManager.list();
      if (sessions.length === 0) {
        return 'No saved sessions yet.';
      }

      const options = sessions.slice(0, 12).map((session) => this.formatSessionListItem(session));
      const answer = await this.promptForChoice('Choose a session to resume', options);
      const selectedIndex = options.indexOf(answer);
      const selected = selectedIndex >= 0 ? sessions[selectedIndex] : null;
      if (!selected) {
        return 'Session selection cancelled.';
      }

      await this.resumeSessionById(selected.id);
      return `Resumed ${this.formatSessionTitle(selected)}.`;
    }

    if (command === 'resume') {
      const reference = args[1]?.trim();
      if (!reference) {
        return 'Usage: /session resume <id|index> or /session pick';
      }
      const sessions = await this.sessionManager.list();
      const resolved = this.resolveSessionReference(sessions, reference);
      if (!resolved) {
        return `Session not found: ${reference}`;
      }
      await this.resumeSessionById(resolved.id);
      return `Resumed ${this.formatSessionTitle(resolved)}.`;
    }

    return 'Usage: /session [list|last|pick|resume <id|index>]';
  }

  private async runMemoryCommand(args: string[]): Promise<string> {
    const command = args[0]?.trim().toLowerCase() ?? '';
    if (!command || command === 'read') {
      if (command === 'read' && args[1]) {
        const scope = this.parseMemoryScope(args[1]?.trim().toLowerCase());
        if (!scope) {
          return 'Usage: /memory read [global|project|working|episodic|semantic|procedural]';
        }
        const memory = await loadMemory(process.cwd());
        const title = `## ${scope.charAt(0).toUpperCase() + scope.slice(1)} Memory\n`;
        const section = memory.split(/\n(?=## )/u).find((entry) => entry.startsWith(title));
        return section ? `Memory\n${section.replace(title, '')}` : `Memory (${scope}) is empty.`;
      }
      return this.formatMemorySummary();
    }

    if (command === 'write' || command === 'append') {
      const scope = this.parseMemoryScope(args[1]?.trim().toLowerCase());
      if (!scope) {
        return `Usage: /memory ${command} <global|project|working|episodic|semantic|procedural> <content>`;
      }
      const content = args.slice(2).join(' ').trim();
      if (!content) {
        return `Usage: /memory ${command} <global|project|working|episodic|semantic|procedural> <content>`;
      }
      if (command === 'write') {
        await saveMemory(process.cwd(), content, scope);
      } else {
        await appendMemory(process.cwd(), content, scope);
      }
      this.invalidateDerivedCaches({ memory: true });
      await this.refreshSystemPrompt();
      this.scheduleStatePush();
      return `Memory ${command === 'write' ? 'written' : 'appended'} in ${scope}.`;
    }

    if (command === 'clear') {
      const scope = this.parseMemoryScope(args[1]?.trim().toLowerCase());
      if (!scope) {
        return 'Usage: /memory clear <global|project|working|episodic|semantic|procedural>';
      }
      await clearMemory(process.cwd(), scope);
      this.invalidateDerivedCaches({ memory: true });
      await this.refreshSystemPrompt();
      this.scheduleStatePush();
      return `Memory cleared in ${scope}.`;
    }

    return 'Usage: /memory [read [scope]|write <scope> <content>|append <scope> <content>|clear <scope>]';
  }

  private async getChangedFiles(limit: number = 8): Promise<string[]> {
    const cached = this.readTimedCache(this.changedFilesCache);
    if (cached) {
      return cached.slice(0, limit);
    }

    try {
      const { stdout } = await execFileAsync('git', ['status', '--short'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });

      const files = stdout
        .split('\n')
        .map((line) => line.replace(/\r/g, ''))
        .map((line) => STATUS_FILE_PATTERN.exec(line)?.[1]?.trim() ?? '')
        .filter((line) => line.length > 0)
        .map((line) => line.replace(/^.* -> /, ''))
        .slice(0, 16);
      this.changedFilesCache = this.writeTimedCache(files, 900);
      return files.slice(0, limit);
    } catch {
      try {
        const git = new GitCheckpoint(process.cwd());
        const diff = await git.getDiff();
        const files = new Set<string>();
        let match = DIFF_FILE_PATTERN.exec(diff);
        while (match) {
          const filePath = match[1]?.trim();
          if (filePath) {
            files.add(filePath);
          }
          match = DIFF_FILE_PATTERN.exec(diff);
        }
        DIFF_FILE_PATTERN.lastIndex = 0;
        const resolved = Array.from(files.values()).slice(0, 16);
        this.changedFilesCache = this.writeTimedCache(resolved, 900);
        return resolved.slice(0, limit);
      } catch {
        return [];
      }
    }
  }

  private extractPromptFileHints(prompt: string): string[] {
    const matches = prompt.match(/(?:^|[\s`"'(])([./]?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)+)(?=$|[\s`"'),:;])/gu) ?? [];
    return Array.from(
      new Set(
        matches
          .map((entry) => entry.trim().replace(/^['"`(]+|['"`),:;]+$/gu, ''))
          .filter((entry) => entry.length > 0),
      ),
    ).slice(0, 8);
  }

  private inferPromptPurpose(prompt: string): DelegationPurpose | 'general' {
    const lower = prompt.toLowerCase();
    if (/\b(ui|ux|design|layout|spacing|typography|visual|a11y|accessibility|color)\b|(?:디자인|레이아웃|타이포|접근성|색상)/u.test(lower)) {
      return 'design';
    }
    if (/\b(plan|planning|architecture|architect|strategy|roadmap|tradeoff|spec|design doc)\b|(?:계획|플랜|설계|아키텍처|전략|로드맵|스펙)/u.test(lower)) {
      return 'planning';
    }
    if (/\b(review|audit|verify|validation|regression|risk|critic|critique)\b|(?:리뷰|검토|검증|감사|리스크|회귀)/u.test(lower)) {
      return 'review';
    }
    if (/\b(research|investigate|look into|survey|compare|explore)\b|(?:리서치|조사|찾아|찾아줘|비교|탐색|분석해|알아봐)/u.test(lower)) {
      return 'research';
    }
    if (/\b(implement|build|fix|write|edit|refactor|patch|ship|code|change)\b|(?:구현|수정|고쳐|작성|편집|리팩터|패치|코드|변경)/u.test(lower)) {
      return 'execution';
    }
    return 'general';
  }

  private isLikelyExternalResearchPrompt(prompt: string): boolean {
    if (this.extractPromptFileHints(prompt).length > 0) {
      return false;
    }

    if (this.extractPromptSymbolHints(prompt, 4).length > 0) {
      return false;
    }

    const lower = prompt.toLowerCase();
    if (
      /\b(file|files|repo|repository|codebase|function|class|module|component|api|schema|diff|commit|refactor|build|test|lint|mcp|lsp|prompt|config)\b/u.test(lower)
      || /(?:파일|레포|리포지토리|코드베이스|함수|클래스|모듈|컴포넌트|스키마|커밋|빌드|테스트|린트|설정|심볼)/u.test(lower)
    ) {
      return false;
    }

    return true;
  }

  private getPromptContextSnapshotOptions(
    prompt: string | undefined,
    purpose: DelegationPurpose | 'general',
    scope: 'request' | 'delegation' | 'team' = 'request',
  ): ContextSnapshotOptions {
    if (!prompt || purpose !== 'research' || !this.isLikelyExternalResearchPrompt(prompt)) {
      return {};
    }

    return {
      includeRelevantFiles: false,
      includeChangedFiles: false,
      includeBriefing: false,
      includePlan: false,
      includeUncertainties: false,
      includeOperationalState: false,
      includeMemory: false,
      maxArtifacts: scope === 'team' ? 1 : 0,
    };
  }

  private extractRankedFilesFromSearch(output: string, limit: number = 5): string[] {
    const files = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('# '))
      .map((line) => line.slice(2))
      .map((line) => line.replace(/\s+\(score.+$/u, '').trim())
      .filter((line) => line.length > 0);
    return Array.from(new Set(files)).slice(0, limit);
  }

  private extractPromptSymbolHints(prompt: string, limit: number = 4): string[] {
    const backticked = Array.from(prompt.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/gu))
      .map((match) => match[1] ?? '')
      .filter((value) => value.length >= 3);
    const codeLike = Array.from(
      prompt.matchAll(/\b(?:[A-Z][A-Za-z0-9_]{2,}|[a-z]+(?:[A-Z][A-Za-z0-9_]+)+|[a-z_]{3,}_[a-z0-9_]+)\b/gu),
    )
      .map((match) => match[0] ?? '')
      .filter((value) => value.length >= 3);
    const ranked = Array.from(new Set([...backticked, ...codeLike])).filter((value) => {
      const lower = value.toLowerCase();
      return ![
        'context',
        'prompt',
        'design',
        'review',
        'research',
        'implement',
        'background',
        'parallel',
        'sequential',
        'artifact',
      ].includes(lower);
    });
    return ranked.slice(0, limit);
  }

  private extractFilesFromLineMatches(output: string, limit: number = 5): string[] {
    const files = output
      .split('\n')
      .map((line) => line.trim())
      .map((line) => /^([^:\s]+):\d+:/u.exec(line)?.[1] ?? '')
      .filter((line) => line.length > 0);
    return Array.from(new Set(files)).slice(0, limit);
  }

  private addFileScore(scores: Map<string, number>, filePath: string, value: number): void {
    const normalized = filePath.trim();
    if (!normalized) {
      return;
    }
    scores.set(normalized, (scores.get(normalized) ?? 0) + value);
  }

  private addRankedOutputScores(
    scores: Map<string, number>,
    output: string,
    weightMultiplier: number,
  ): void {
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('# ')) {
        continue;
      }
      const match = /^#\s+(.+?)\s+\(score\s+(\d+)/u.exec(trimmed);
      if (!match) {
        continue;
      }
      const filePath = match[1]?.trim();
      const score = Number.parseInt(match[2] ?? '0', 10);
      if (!filePath || !Number.isFinite(score)) {
        continue;
      }
      this.addFileScore(scores, filePath, Math.max(1, Math.min(score, 24)) * weightMultiplier);
    }
  }

  private changedFileRelevanceWeight(purpose: DelegationPurpose | 'general'): number {
    switch (purpose) {
      case 'execution':
        return 18;
      case 'review':
        return 16;
      case 'design':
        return 10;
      case 'planning':
        return 8;
      case 'research':
        return 6;
      default:
        return 10;
    }
  }

  private async getRelevantFilesForPrompt(
    prompt: string,
    purpose?: DelegationPurpose | 'general',
    limit: number = 5,
  ): Promise<string[]> {
    const hintedFiles = this.extractPromptFileHints(prompt);
    const effectivePurpose = purpose ?? this.inferPromptPurpose(prompt);
    const scores = new Map<string, number>();
    for (const filePath of hintedFiles) {
      this.addFileScore(scores, filePath, 32);
    }

    const changedFiles = await this.getChangedFiles(10);
    const changedWeight = this.changedFileRelevanceWeight(effectivePurpose);
    for (const filePath of changedFiles) {
      this.addFileScore(scores, filePath, changedWeight);
    }

    const symbolHints = this.extractPromptSymbolHints(prompt, 3);
    const importanceTool = this.toolRegistry?.get('file_importance');
    const codebaseTool = this.toolRegistry?.get('codebase_search');
    const definitionTool = this.toolRegistry?.get('definition_search') ?? this.toolRegistry?.get('symbol_search');
    const hotspotTool = this.toolRegistry?.get('reference_hotspots') ?? this.toolRegistry?.get('reference_search');

    const pendingSearches: Array<Promise<void>> = [];
    if (importanceTool) {
      pendingSearches.push((async () => {
        try {
          const result = await importanceTool.execute(
            {
              query: prompt,
              purpose: effectivePurpose,
              max_results: Math.max(limit, 8),
            },
            { cwd: process.cwd(), lsp: this.lspManager },
          );
          this.addRankedOutputScores(scores, result.output, 3);
          for (const filePath of this.extractRankedFilesFromSearch(result.output, limit + 3)) {
            this.addFileScore(scores, filePath, 14);
          }
        } catch {
          // Fall back to other signals.
        }
      })());
    } else if (codebaseTool) {
      pendingSearches.push((async () => {
        try {
          const query = effectivePurpose && effectivePurpose !== 'general'
            ? `${effectivePurpose} ${prompt}`
            : prompt;
          const result = await codebaseTool.execute(
            {
              query,
              max_results: Math.max(limit, 8),
            },
            { cwd: process.cwd(), lsp: this.lspManager },
          );
          this.addRankedOutputScores(scores, result.output, 2);
          for (const filePath of this.extractRankedFilesFromSearch(result.output, limit + 3)) {
            this.addFileScore(scores, filePath, 10);
          }
        } catch {
          // Fall back to prompt/file hints only.
        }
      })());
    }

    for (const symbol of symbolHints) {
      if (definitionTool) {
        pendingSearches.push((async () => {
          try {
            const result = await definitionTool.execute(
              {
                query: symbol,
                max_results: Math.max(limit, 6),
              },
              { cwd: process.cwd(), lsp: this.lspManager },
            );
            this.addRankedOutputScores(scores, result.output, 2);
            for (const filePath of this.extractFilesFromLineMatches(result.output, limit + 2)) {
              this.addFileScore(scores, filePath, 12);
            }
          } catch {
            // Ignore symbol-specific failures.
          }
        })());
      }

      if (hotspotTool) {
        pendingSearches.push((async () => {
          try {
            const result = await hotspotTool.execute(
              {
                query: symbol,
                max_results: Math.max(limit, 6),
              },
              { cwd: process.cwd(), lsp: this.lspManager },
            );
            this.addRankedOutputScores(scores, result.output, 1);
            for (const filePath of this.extractFilesFromLineMatches(result.output, limit + 2)) {
              this.addFileScore(scores, filePath, 8);
            }
          } catch {
            // Ignore symbol-specific failures.
          }
        })());
      }
    }

    await Promise.all(pendingSearches);

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([filePath]) => filePath)
      .slice(0, limit);
  }

  private async buildPromptContextSnapshot(
    prompt?: string,
    purpose?: DelegationPurpose | 'general',
    options: ContextSnapshotOptions = {},
  ): Promise<string> {
    const parts: string[] = [];
    const effectivePurpose = purpose ?? (prompt ? this.inferPromptPurpose(prompt) : 'general');
    const snapshotOptions: Required<ContextSnapshotOptions> = {
      includeRelevantFiles: options.includeRelevantFiles ?? true,
      includeChangedFiles: options.includeChangedFiles ?? true,
      includeBriefing: options.includeBriefing ?? true,
      includePlan: options.includePlan ?? true,
      includeUncertainties: options.includeUncertainties ?? (effectivePurpose === 'planning' || effectivePurpose === 'research' || effectivePurpose === 'review'),
      includeOperationalState: options.includeOperationalState ?? (effectivePurpose === 'planning' || effectivePurpose === 'general'),
      includeMemory: options.includeMemory ?? true,
      memoryScopes: options.memoryScopes ?? this.getRequestMemoryScopes(effectivePurpose),
      maxArtifacts: options.maxArtifacts ?? (effectivePurpose === 'planning' || effectivePurpose === 'review' ? 4 : 3),
    };
    const cacheKey = this.buildPromptContextCacheKey(prompt, effectivePurpose, snapshotOptions);
    const cached = this.promptContextCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    if (prompt) {
      parts.push(`request_focus: ${effectivePurpose}`);
      if (snapshotOptions.includeRelevantFiles) {
        const relevantFiles = await this.getRelevantFilesForPrompt(prompt, effectivePurpose, 5);
        if (relevantFiles.length > 0) {
          parts.push(
            'relevant_files:',
            ...relevantFiles.map((filePath) => `- ${filePath}`),
          );
        }
      }
    }
    const relevantArtifacts = this.getArtifactsForPurpose(effectivePurpose, snapshotOptions.maxArtifacts);
    if (relevantArtifacts.length > 0) {
      parts.push(
        ...relevantArtifacts.map((artifact) => {
          const mode = artifact.mode ? ` · ${HARNESS_MODES[artifact.mode].label}` : '';
          return `artifact: ${formatArtifactContextLine(artifact, 140)}${mode ? mode : ''}`;
        }),
      );
    }
    if (snapshotOptions.includeMemory) {
      try {
        const selectedMemory = await this.getCachedSelectedMemory(snapshotOptions.memoryScopes, 320);
        if (hasMeaningfulMemory(selectedMemory)) {
          parts.push('<memory_selection>', selectedMemory, '</memory_selection>');
        }
      } catch {
        // Selected memory is optional.
      }
    }

    if (snapshotOptions.includeChangedFiles) {
      const changedFiles = await this.getChangedFiles(8);
      if (changedFiles.length > 0) {
        parts.push(
          'changed_files:',
          ...changedFiles.map((filePath) => `- ${filePath}`),
        );
      }
    }

    if (snapshotOptions.includeBriefing) {
      const briefing = await this.getBriefingSummary();
      if (briefing) {
        parts.push(
          `briefing_summary: ${briefing.summary}`,
          ...briefing.nextSteps.slice(0, 4).map((step) => `next_step: ${previewText(step, 180)}`),
        );
      }
    }

    if (snapshotOptions.includePlan && this.todos.length > 0) {
      parts.push(
        ...this.todos
          .filter((item) => effectivePurpose === 'planning' || item.status !== 'completed')
          .slice(0, 5)
          .map((item) => `plan_item: [${item.status}] ${previewText(item.step, 180)}`),
      );
    }

    if (snapshotOptions.includeUncertainties) {
      const uncertainties = this.epistemicState.getState().activeUncertainties
        .slice(0, 3)
        .map((item) => item.content)
        .filter((item) => item.trim().length > 0);
      if (uncertainties.length > 0) {
        parts.push(...uncertainties.map((item) => `uncertainty: ${previewText(item, 180)}`));
      }
    }

    if (snapshotOptions.includeOperationalState) {
      const activeAgents = this.agentActivities
        .filter((item) => item.status === 'running' || item.status === 'verifying' || item.status === 'queued')
        .slice(0, 2);
      if (activeAgents.length > 0) {
        parts.push(
          ...activeAgents.map((item) => {
            const scope = [item.mode ? HARNESS_MODES[item.mode].label : item.label, item.purpose]
              .filter((part): part is string => Boolean(part))
              .join(' · ');
            const detail = item.detail ? ` · ${previewText(item.detail, 100)}` : '';
            return `active_agent: ${scope} · ${item.status}${detail}`;
          }),
        );
      }

      const activeBackgroundJobs = this.backgroundJobs
        .filter((job) => job.status === 'running')
        .slice(0, 2);
      if (activeBackgroundJobs.length > 0) {
        parts.push(
          ...activeBackgroundJobs.map((job) => {
            const detail = job.detail ? ` · ${previewText(job.detail, 100)}` : '';
            return `background_job: ${job.label} · ${job.kind}${detail}`;
          }),
        );
      }
    }

    if (this.state.workspace?.path) {
      parts.push(`workspace: ${this.state.workspace.path}`);
    }

    if (parts.length === 0) {
      return '';
    }

    const snapshot = `<context_snapshot>\n${parts.join('\n')}\n</context_snapshot>`;
    this.promptContextCache.set(cacheKey, this.writeTimedCache(snapshot, 1200));
    this.trimTimedMap(this.promptContextCache, 48);
    return snapshot;
  }

  private async formatContextSummary(): Promise<string> {
    const changedFiles = await this.getChangedFiles(12);
    let briefingSummary = 'none';
    let briefingSteps: string[] = [];
    try {
      const briefing = await this.getBriefingSummary();
      if (briefing) {
        briefingSummary = briefing.summary;
        briefingSteps = briefing.nextSteps.slice(0, 5);
      }
    } catch {
      briefingSummary = 'unavailable';
    }

    const activeAgents = this.agentActivities
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6)
      .map((item) => {
        const scope = [item.mode ? HARNESS_MODES[item.mode].label : item.label, item.purpose]
          .filter((part): part is string => Boolean(part))
          .join(' · ');
        return `${scope} · ${item.status}${item.detail ? ` · ${previewText(item.detail, 120)}` : ''}`;
      });

    const backgroundJobs = this.backgroundJobs
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 4)
      .map((job) => `${job.label} · ${job.status}${job.detail ? ` · ${previewText(job.detail, 120)}` : ''}`);
    const artifacts = this.artifacts
      .slice(0, 6)
      .map((artifact) => formatArtifactContextLine(artifact, 180));

    return [
      'Context Snapshot',
      '',
      'What ddudu currently includes in the live prompt:',
      '- base system prompt + mode prompt addition',
      '- DDUDU.md / AGENTS.md / provider instruction files',
      '- global + project rules',
      '- loaded skills',
      '- layered memory',
      '- workflow state (permissions + todo plan)',
      '- dynamic context snapshot (changed files, briefing, uncertainties, active agents, background jobs, workspace)',
      '',
      `Changed files: ${changedFiles.length > 0 ? changedFiles.join(', ') : 'none'}`,
      `Briefing: ${briefingSummary}`,
      ...(briefingSteps.length > 0
        ? ['Next steps:', ...briefingSteps.map((step) => `- ${step}`)]
        : ['Next steps: none']),
      ...(activeAgents.length > 0
        ? ['Recent agents:', ...activeAgents.map((entry) => `- ${entry}`)]
        : ['Recent agents: none']),
      ...(backgroundJobs.length > 0
        ? ['Background jobs:', ...backgroundJobs.map((entry) => `- ${entry}`)]
        : ['Background jobs: none']),
      ...(artifacts.length > 0
        ? ['Artifacts:', ...artifacts.map((entry) => `- ${entry}`)]
        : ['Artifacts: none']),
      `Uncertainties: ${this.epistemicState.getStats().uncertainties}`,
    ].join('\n');
  }

  private async formatSkillSummary(): Promise<string> {
    try {
      const loader = new SkillLoader(process.cwd());
      await loader.scan();
      const skills = loader.list();
      if (skills.length === 0) {
        return 'No skills discovered.';
      }

      return [
        'Skills',
        ...skills.slice(0, 12).map((skill) => {
          const loaded = this.loadedSkills.has(skill.name) ? 'loaded' : 'available';
          return `${skill.name} · ${loaded} · ${skill.description}`;
        }),
      ].join('\n');
    } catch (error: unknown) {
      return `Skill scan failed: ${serializeError(error)}`;
    }
  }

  private async loadSkillSummary(name: string): Promise<string> {
    try {
      const loader = new SkillLoader(process.cwd());
      await loader.scan();
      const skill = await loader.load(name);
      if (!skill) {
        return `Skill not found: ${name}`;
      }

      this.loadedSkills.set(skill.name, skill);
      await this.refreshSystemPrompt();
      this.scheduleStatePush();
      return `Skill loaded into context: ${skill.name}`;
    } catch (error: unknown) {
      return `Skill load failed: ${serializeError(error)}`;
    }
  }

  private async runReviewSummary(): Promise<string> {
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
      return `Review failed: ${serializeError(error)}`;
    }
  }

  private setWorkspaceState(workspace: IsolatedWorkspace | null): void {
    this.state.workspace = workspace
      ? {
          label: workspace.label,
          path: workspace.path,
          kind: workspace.kind,
        }
      : null;
    this.scheduleStatePush();
  }

  private setVerificationState(state: NativeVerificationState | null): void {
    this.state.verification = state;
    this.scheduleStatePush();
  }

  private syncAgentActivities(): void {
    this.state.agentActivities = this.agentActivities
      .slice()
      .sort((a, b) => {
        const priority = (activity: AgentActivityState): number => {
          if (activity.status === 'running' || activity.status === 'verifying') {
            return 0;
          }
          if (activity.status === 'queued') {
            return 1;
          }
          if (activity.status === 'error') {
            return 2;
          }
          return 3;
        };

        return priority(a) - priority(b) || b.updatedAt - a.updatedAt;
      })
      .slice(0, 8)
      .map((activity) => ({ ...activity }));
  }

  private syncBackgroundJobs(): void {
    this.state.backgroundJobs = this.backgroundJobs
      .slice()
      .sort((a, b) => {
        const priority = (job: BackgroundJobState): number => {
          if (job.status === 'running') {
            return 0;
          }
          if (job.status === 'cancelled') {
            return 1;
          }
          if (job.status === 'error') {
            return 2;
          }
          return 3;
        };

        return priority(a) - priority(b) || b.updatedAt - a.updatedAt;
      })
      .slice(0, 8)
      .map((job) => ({
        id: job.id,
        kind: job.kind,
        label: job.label,
        status: job.status,
        detail: job.detail,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt ?? null,
        purpose: job.purpose ?? null,
        preferredMode: job.preferredMode ?? null,
        strategy: job.strategy ?? null,
        attempt: job.attempt ?? null,
        hasResult: job.hasResult ?? false,
        resultPreview: job.resultPreview ?? null,
        workspacePath: job.workspacePath ?? null,
        promptPreview: job.prompt ? previewText(job.prompt, 96) : null,
        checklist: job.checklist.map((item) => ({ ...item })),
      }));
  }

  private syncQueuedPrompts(): void {
    this.state.queuedPrompts = [...this.queuedPrompts];
    this.scheduleStatePush();
    void this.persistWorkflowState('queue_update');
  }

  private syncArtifacts(): void {
    this.state.artifacts = this.artifacts
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10)
      .map((artifact) => ({ ...artifact }));
  }

  private updateAgentActivity(update: {
    id: string;
    label: string;
    status: AgentActivityState['status'];
    mode?: NamedMode | null;
    purpose?: string | null;
    checklistId?: string | null;
    detail?: string | null;
    workspacePath?: string | null;
  }): void {
    const existing = this.agentActivities.find((activity) => activity.id === update.id);
    if (existing) {
      existing.label = update.label;
      existing.status = update.status;
      existing.mode = update.mode ?? existing.mode;
      existing.purpose = update.purpose ?? existing.purpose;
      existing.checklistId = update.checklistId ?? existing.checklistId;
      existing.detail = update.detail ?? existing.detail;
      existing.workspacePath = update.workspacePath ?? existing.workspacePath;
      existing.updatedAt = Date.now();
    } else {
      this.agentActivities.push({
        id: update.id,
        label: update.label,
        status: update.status,
        mode: update.mode ?? null,
        purpose: update.purpose ?? null,
        checklistId: update.checklistId ?? null,
        detail: update.detail ?? null,
        workspacePath: update.workspacePath ?? null,
        updatedAt: Date.now(),
      });
    }

    this.syncAgentActivities();
    this.scheduleStatePush();
  }

  private resetEphemeralAgentActivities(): void {
    this.agentActivities = this.agentActivities.filter(
      (activity) => activity.status === 'error' || activity.id.startsWith('job:'),
    );
    this.syncAgentActivities();
  }

  private updateBackgroundJob(update: {
    id: string;
    kind: BackgroundJobState['kind'];
    label: string;
    status: BackgroundJobState['status'];
    detail?: string | null;
    startedAt?: number;
    prompt?: string;
    purpose?: DelegationPurpose | 'general';
    preferredMode?: NamedMode | null;
    strategy?: 'parallel' | 'sequential' | 'delegate';
    reason?: string | null;
    artifactId?: string | null;
    artifactTitle?: string | null;
    verificationSummary?: string | null;
    attempt?: number;
    checklist?: BackgroundJobChecklistItem[];
    controller?: AbortController | null;
  }): void {
    const existing = this.backgroundJobs.find((job) => job.id === update.id);
    if (existing) {
      existing.kind = update.kind;
      existing.label = update.label;
      existing.status = update.status;
      existing.detail = update.detail ?? existing.detail;
      existing.finishedAt = update.status === 'running' ? null : Date.now();
      existing.prompt = update.prompt ?? existing.prompt;
      existing.purpose = update.purpose ?? existing.purpose;
      existing.preferredMode = update.preferredMode ?? existing.preferredMode;
      existing.strategy = update.strategy ?? existing.strategy;
      existing.reason = update.reason ?? existing.reason;
      existing.artifactId = update.artifactId ?? existing.artifactId;
      existing.artifactTitle = update.artifactTitle ?? existing.artifactTitle;
      existing.verificationSummary = update.verificationSummary ?? existing.verificationSummary;
      existing.attempt = update.attempt ?? existing.attempt;
      existing.hasResult = update.status === 'done' ? true : existing.hasResult;
      existing.checklist = update.checklist ?? existing.checklist;
      existing.controller = update.controller ?? existing.controller;
      existing.updatedAt = Date.now();
    } else {
      const now = Date.now();
      this.backgroundJobs.push({
        id: update.id,
        kind: update.kind,
        label: update.label,
        status: update.status,
        detail: update.detail ?? null,
        startedAt: update.startedAt ?? now,
        updatedAt: now,
        finishedAt: update.status === 'running' ? null : now,
        prompt: update.prompt,
        purpose: update.purpose,
        preferredMode: update.preferredMode ?? null,
        strategy: update.strategy,
        reason: update.reason ?? null,
        artifactId: update.artifactId ?? null,
        artifactTitle: update.artifactTitle ?? null,
        verificationSummary: update.verificationSummary ?? null,
        attempt: update.attempt ?? 0,
        hasResult: update.status === 'done',
        resultPreview: null,
        workspacePath: null,
        checklist: update.checklist ?? [],
        controller: update.controller ?? null,
      });
    }

    this.syncBackgroundJobs();
    this.scheduleStatePush();
    void this.persistWorkflowState('background_job_update');
  }

  private rememberArtifact(artifact: {
    kind: WorkflowArtifactKind;
    title: string;
    summary: string;
    payload?: WorkflowArtifactPayload;
    source: 'delegate' | 'team' | 'session';
    mode?: NamedMode;
  }): WorkflowArtifact {
    const created: WorkflowArtifact = {
      id: randomUUID(),
      kind: artifact.kind,
      title: artifact.title.trim(),
      summary: previewText(artifact.summary, 220),
      payload: artifact.payload,
      source: artifact.source,
      mode: artifact.mode,
      createdAt: new Date().toISOString(),
    };
    this.artifacts.unshift(created);
    this.artifacts = this.artifacts.slice(0, 20);
    this.syncArtifacts();
    void this.persistWorkflowState('artifact_update');
    this.scheduleStatePush();
    return created;
  }

  private artifactKindForPurpose(purpose?: DelegationPurpose): WorkflowArtifactKind {
    switch (purpose) {
      case 'planning':
        return 'plan';
      case 'review':
      case 'oracle':
        return 'review';
      case 'design':
        return 'design';
      case 'research':
        return 'research';
      case 'execution':
        return 'patch';
      default:
        return 'answer';
    }
  }

  private rememberDelegationArtifact(result: {
    purpose?: DelegationPurpose;
    requestedKind?: WorkflowArtifactKind;
    mode: NamedMode;
    text: string;
    task?: string;
    verification?: VerificationSummary;
    workspaceApply?: {
      applied: boolean;
      empty: boolean;
      summary: string;
      error?: string;
      path?: string | null;
    } | null;
  }): WorkflowArtifact {
    const kind = result.requestedKind ?? this.artifactKindForPurpose(result.purpose);
    const title = `${HARNESS_MODES[result.mode].label} ${kind}`;
    return this.rememberArtifact({
      kind,
      title,
      summary: result.text,
      payload: buildArtifactPayload({
        kind,
        purpose: result.purpose,
        task: result.task,
        summary: result.text,
        files: result.verification?.changedFiles,
        verification: result.verification,
        workspaceApply: result.workspaceApply ?? null,
      }),
      source: 'delegate',
      mode: result.mode,
    });
  }

  private rememberSessionArtifact(
    purpose: DelegationPurpose | 'general',
    text: string,
    prompt?: string,
  ): WorkflowArtifact {
    const kind = this.artifactKindForPurpose(purpose === 'general' ? undefined : purpose);
    const title = `${HARNESS_MODES[this.currentMode].label} ${kind}`;
    return this.rememberArtifact({
      kind,
      title,
      summary: text,
      payload: buildArtifactPayload({
        kind,
        purpose,
        prompt,
        summary: text,
      }),
      source: 'session',
      mode: this.currentMode,
    });
  }

  private rememberTeamArtifact(
    strategy: 'parallel' | 'sequential' | 'delegate',
    task: string,
    output: string,
    notes: string[] = [],
  ): WorkflowArtifact {
    return this.rememberArtifact({
      kind: 'briefing',
      title: `team ${strategy}`,
      summary: `${previewText(task, 120)} · ${previewText(output, 220)}`,
      payload: buildArtifactPayload({
        kind: 'briefing',
        purpose: 'general',
        task,
        strategy,
        summary: output,
        notes,
      }),
      source: 'team',
      mode: this.currentMode,
    });
  }

  private rememberTeamPlanArtifact(
    strategy: 'parallel' | 'sequential' | 'delegate',
    task: string,
    allocation: WorkAllocationPlan,
  ): WorkflowArtifact {
    const planSteps = allocation.units.map((unit) => unit.label);
    const assignments = allocation.units.map((unit) => {
      const modeLabel = unit.preferredMode ? HARNESS_MODES[unit.preferredMode]?.label ?? unit.preferredMode : 'Auto';
      const access = unit.readOnly ? 'read-only' : 'write';
      return [
        modeLabel,
        unit.role,
        unit.label,
        access,
        unit.dependsOn.length > 0 ? `after ${unit.dependsOn.join(', ')}` : null,
        unit.handoffTo ? `handoff ${getSpecialistRoleProfile(unit.handoffTo).label}` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' · ');
    });

    return this.rememberArtifact({
      kind: 'plan',
      title: `team ${strategy} plan`,
      summary: `${previewText(task, 120)} · ${planSteps.join(' · ')}`,
      payload: buildArtifactPayload({
        kind: 'plan',
        purpose: 'planning',
        task,
        strategy,
        assignments,
        notes: allocation.units.map((unit) => unit.brief),
        summary: planSteps.map((step, index) => `${index + 1}. ${step}`).join('\n'),
      }),
      source: 'team',
      mode: this.currentMode,
    });
  }

  private artifactScoreForPurpose(
    artifact: WorkflowArtifact,
    purpose: DelegationPurpose | 'general',
  ): number {
    let score = 1;

    if (purpose === 'general') {
      if (artifact.kind === 'briefing') {
        score += 6;
      }
    } else {
      const preferredKinds: Record<DelegationPurpose, WorkflowArtifactKind[]> = {
        general: ['briefing', 'answer'],
        execution: ['patch', 'plan', 'review', 'briefing'],
        planning: ['plan', 'briefing', 'review', 'research'],
        research: ['research', 'briefing', 'plan', 'review'],
        review: ['review', 'patch', 'plan', 'briefing'],
        design: ['design', 'plan', 'briefing', 'review'],
        oracle: ['review', 'research', 'briefing', 'plan'],
      };
      const index = preferredKinds[purpose].indexOf(artifact.kind);
      if (index >= 0) {
        score += 10 - index * 2;
      }
    }

    if (artifact.source === 'team') {
      score += 2;
    }
    if (artifact.mode === this.currentMode) {
      score += 1;
    }

    const agePenalty = this.artifacts.findIndex((item) => item.id === artifact.id);
    if (agePenalty >= 0) {
      score += Math.max(0, 6 - agePenalty);
    }

    return score;
  }

  private getArtifactsForPurpose(
    purpose: DelegationPurpose | 'general' = 'general',
    limit: number = 4,
  ): WorkflowArtifact[] {
    return this.artifacts
      .slice()
      .sort((a, b) => {
        return this.artifactScoreForPurpose(b, purpose) - this.artifactScoreForPurpose(a, purpose)
          || b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, limit)
      .map((artifact) => ({ ...artifact }));
  }

  private getArtifactById(id: string | null | undefined): WorkflowArtifact | null {
    if (!id) {
      return null;
    }

    return this.artifacts.find((artifact) => artifact.id === id) ?? null;
  }

  private rememberVerificationArtifact(
    verification: VerificationSummary,
    mode: NamedMode,
    title: string,
  ): WorkflowArtifact {
    return this.rememberArtifact({
      kind: 'review',
      title,
      summary: `${verification.summary}\n${previewText(verification.report, 260)}`,
      payload: buildArtifactPayload({
        kind: 'review',
        purpose: 'review',
        summary: verification.report,
        files: verification.changedFiles,
        verification,
      }),
      source: 'session',
      mode,
    });
  }

  private async ensureVerificationTodo(verification: VerificationSummary): Promise<void> {
    const step = `Resolve verification failures: ${previewText(verification.summary, 120)}`;
    if (this.todos.some((item) => item.step === step)) {
      return;
    }

    await this.addPlanItem(step, 'pending', 'review');
  }

  private async completeVerificationTodos(): Promise<void> {
    let changed = false;
    for (const item of this.todos) {
      if (item.status === 'completed') {
        continue;
      }
      if (!item.step.startsWith('Resolve verification failures:')) {
        continue;
      }
      item.status = 'completed';
      item.owner = 'verified';
      item.updatedAt = new Date().toISOString();
      changed = true;
    }

    if (!changed) {
      return;
    }

    this.state.todos = this.todos.map((item) => ({ ...item }));
    await this.refreshSystemPrompt();
    this.scheduleStatePush();
    void this.persistWorkflowState('verification_todo_resolve');
  }

  private rememberRepairArtifact(input: {
    purpose: DelegationPurpose | 'general';
    mode: NamedMode;
    output: string;
    verification: VerificationSummary;
  }): WorkflowArtifact {
    return this.rememberArtifact({
      kind: 'patch',
      title: `${HARNESS_MODES[input.mode].label} repair patch`,
      summary: [
        `purpose: ${input.purpose}`,
        `verification: ${input.verification.summary}`,
        '',
        previewText(input.output, 420),
      ].join('\n'),
      payload: buildArtifactPayload({
        kind: 'patch',
        purpose: input.purpose,
        summary: input.output,
        files: input.verification.changedFiles,
        verification: input.verification,
      }),
      source: 'delegate',
      mode: input.mode,
    });
  }

  private async autoPromoteSuccessfulRunMemory(input: {
    reason?: string | null;
    purpose: DelegationPurpose | 'general';
    output: string;
    mode: NamedMode;
    verification: VerificationSummary;
  }): Promise<void> {
    const fingerprint = input.verification.fingerprint ?? `${input.purpose}:${input.verification.summary}`;
    if (this.memoryPromotionFingerprints.has(fingerprint)) {
      return;
    }
    this.memoryPromotionFingerprints.add(fingerprint);

    const files = input.verification.changedFiles.length > 0
      ? input.verification.changedFiles.slice(0, 6).join(', ')
      : 'not detected';

    await appendMemory(
      process.cwd(),
      [
        `Outcome: ${input.purpose} verified successfully in ${HARNESS_MODES[input.mode].label}.`,
        `Files: ${files}`,
        `Verification: ${input.verification.summary}`,
        `Result: ${previewText(input.output, 280)}`,
      ].join('\n'),
      'semantic',
    );
    this.invalidateDerivedCaches({ memory: true });

    if (input.reason === 'verification auto-retry' || input.reason?.startsWith('Verification escalation') === true) {
      await appendMemory(
        process.cwd(),
        [
          `Repair pattern succeeded for ${input.purpose}.`,
          `Mode: ${HARNESS_MODES[input.mode].label}`,
          `Files: ${files}`,
          `Verification: ${input.verification.summary}`,
          'Guideline: prefer the smallest isolated patch that lands cleanly and rerun verification before returning control.',
        ].join('\n'),
        'procedural',
      );
      this.invalidateDerivedCaches({ memory: true });
    }

    await this.refreshSystemPrompt();
  }

  private async finalizeVerificationRecovery(input: {
    reason?: string | null;
    purpose: DelegationPurpose | 'general';
    output: string;
    mode: NamedMode;
    appliedToBase?: boolean;
    verification?: VerificationSummary | null;
  }): Promise<void> {
    const verification = input.verification;
    if (!verification || verification.status !== 'passed' || input.appliedToBase === false) {
      return;
    }

    await this.completeVerificationTodos();
    if (input.reason === 'verification auto-retry' || input.reason?.startsWith('Verification escalation') === true) {
      this.rememberRepairArtifact({
        purpose: input.purpose,
        mode: input.mode,
        output: input.output,
        verification,
      });
    }
    await this.autoPromoteSuccessfulRunMemory({
      reason: input.reason,
      purpose: input.purpose,
      output: input.output,
      mode: input.mode,
      verification,
    });
  }

  private buildVerificationFollowupPrompt(input: {
    purpose: DelegationPurpose | 'general';
    userPrompt: string;
    assistantOutput: string;
    verification: VerificationSummary;
  }): string {
    const verificationCommandSummary = this.formatVerificationCommandSummary(input.verification);
    return [
      `A ${input.purpose} run produced verification failures.`,
      '',
      'Original request:',
      input.userPrompt,
      '',
      'Current output summary:',
      previewText(input.assistantOutput, 700),
      '',
      'Verification summary:',
      input.verification.summary,
      verificationCommandSummary
        ? `\nStructured command failures:\n${verificationCommandSummary}`
        : '',
      '',
      'Verification report:',
      input.verification.report,
      '',
      'Return a concise reviewer handoff with:',
      '1. likely root cause',
      '2. files or symbols to revisit',
      '3. the smallest safe next patch',
    ].join('\n');
  }

  private buildVerificationRepairPrompt(input: {
    purpose: DelegationPurpose | 'general';
    userPrompt: string;
    assistantOutput: string;
    verification: VerificationSummary;
  }): string {
    const verificationCommandSummary = this.formatVerificationCommandSummary(input.verification);
    return [
      `A previous ${input.purpose} attempt failed verification.`,
      '',
      'Retry this as a repair pass in an isolated workspace.',
      'Keep the patch as small as possible and optimize only for turning the failing checks green.',
      '',
      'Original request:',
      input.userPrompt,
      '',
      'Current failing output summary:',
      previewText(input.assistantOutput, 700),
      '',
      'Verification summary:',
      input.verification.summary,
      verificationCommandSummary
        ? `\nStructured command failures:\n${verificationCommandSummary}`
        : '',
      '',
      'Verification report:',
      input.verification.report,
      '',
      'Return:',
      '1. the minimal repair you made',
      '2. the files touched',
      '3. the final verification status',
    ].join('\n');
  }

  private buildVerificationEscalationTask(input: {
    purpose: DelegationPurpose | 'general';
    userPrompt: string;
    assistantOutput: string;
    verification: VerificationSummary;
  }): string {
    const verificationCommandSummary = this.formatVerificationCommandSummary(input.verification);
    return [
      `Escalate this failing ${input.purpose} request as a coordinated team repair.`,
      '',
      'Original request:',
      input.userPrompt,
      '',
      'Current failing output summary:',
      previewText(input.assistantOutput, 700),
      '',
      'Verification summary:',
      input.verification.summary,
      verificationCommandSummary
        ? `\nStructured command failures:\n${verificationCommandSummary}`
        : '',
      '',
      'Verification report:',
      input.verification.report,
      '',
      'Expected team behavior:',
      '- planner/reviewer isolates the root cause',
      '- executor proposes the smallest safe patch',
      '- reviewer verifies the patch and remaining risks',
      '',
      'Return one merged repair briefing and final verification status.',
    ].join('\n');
  }

  private preferredRetryModeForPurpose(
    purpose: DelegationPurpose | 'general',
  ): NamedMode {
    if (purpose === 'design') {
      return this.getTeamEligibleModes().includes('jisoo') ? 'jisoo' : 'lisa';
    }

    if (purpose === 'review') {
      return this.getTeamEligibleModes().includes('jennie') ? 'jennie' : 'rosé';
    }

    return this.getTeamEligibleModes().includes('lisa') ? 'lisa' : this.currentMode;
  }

  private formatVerificationCommandSummary(verification: VerificationSummary): string | null {
    const failedCommands = verification.commands.filter((command) => !command.ok);
    if (failedCommands.length === 0) {
      return null;
    }

    return failedCommands
      .slice(0, 3)
      .map((command) => {
        const parts = [
          `${command.kind}: ${command.command}${command.exitCode === null ? '' : ` (exit ${command.exitCode})`}`,
          command.category ? `category: ${command.category}` : null,
          command.summary ? `summary: ${command.summary}` : null,
          command.files && command.files.length > 0
            ? `files: ${command.files.slice(0, 2).join(', ')}`
            : null,
          command.highlights && command.highlights.length > 0
            ? `highlights: ${command.highlights.slice(0, 2).join(' | ')}`
            : null,
          command.rerunHint ? `rerun: ${command.rerunHint}` : null,
        ].filter((part): part is string => Boolean(part));
        return `- ${parts.join(' · ')}`;
      })
      .join('\n');
  }

  private async maybeScheduleVerificationFollowup(input: {
    purpose: DelegationPurpose | 'general';
    userPrompt: string;
    assistantOutput: string;
    verification?: VerificationSummary;
    allowRepair?: boolean;
  }): Promise<void> {
    const verification = input.verification;
    if (!verification || verification.status !== 'failed') {
      return;
    }

    this.rememberVerificationArtifact(
      verification,
      this.currentMode,
      `${HARNESS_MODES[this.currentMode].label} verification`,
    );
    await this.ensureVerificationTodo(verification);

    const repairPurpose = input.purpose === 'design' ? 'design' : 'execution';
    const fingerprint = verification.fingerprint ?? `${input.purpose}:${verification.summary}`;
    const repairAttempts = this.verificationRepairFingerprints.get(fingerprint) ?? 0;
    const canAutoRepair =
      input.allowRepair !== false &&
      input.purpose !== 'review' &&
      input.purpose !== 'oracle' &&
      this.canStartBackgroundJob() &&
      repairAttempts < 1;

    if (canAutoRepair) {
      this.verificationRepairFingerprints.set(fingerprint, repairAttempts + 1);
      await this.startBackgroundDelegatedRoute(
        {
          id: randomUUID(),
          role: 'user',
          content: this.buildVerificationRepairPrompt({
            purpose: input.purpose,
            userPrompt: input.userPrompt,
            assistantOutput: input.assistantOutput,
            verification,
          }),
          timestamp: Date.now(),
        },
        {
          kind: 'delegate',
          purpose: repairPurpose,
          preferredMode: this.preferredRetryModeForPurpose(input.purpose),
          reason: 'verification auto-retry',
          repairAttempt: repairAttempts + 1,
        },
      );
      return;
    }

    const canEscalateToTeam =
      input.purpose !== 'review' &&
      input.purpose !== 'oracle' &&
      this.canStartBackgroundJob() &&
      repairAttempts >= 1;

    if (canEscalateToTeam) {
      await this.startBackgroundTeamRun(
        'delegate',
        this.buildVerificationEscalationTask({
          purpose: input.purpose,
          userPrompt: input.userPrompt,
          assistantOutput: input.assistantOutput,
          verification,
        }),
        {
          routeNote: 'Verification escalation · team delegate',
        },
      );
      return;
    }

    if (input.purpose === 'review' || input.purpose === 'oracle' || !this.canStartBackgroundJob()) {
      return;
    }

    const reviewMode = this.getTeamEligibleModes().includes('rosé') ? 'rosé' : 'jennie';
    await this.startBackgroundDelegatedRoute(
      {
        id: randomUUID(),
        role: 'user',
        content: this.buildVerificationFollowupPrompt({
          purpose: input.purpose,
          userPrompt: input.userPrompt,
          assistantOutput: input.assistantOutput,
          verification,
        }),
        timestamp: Date.now(),
      },
      {
        kind: 'delegate',
        purpose: 'review',
        preferredMode: reviewMode,
        reason: 'verification follow-up',
      },
    );
  }

  private async runAutoVerification(
    cwd: string,
    mode: Exclude<VerificationMode, 'none'> = 'full',
  ): Promise<VerificationSummary> {
    this.setVerificationState({
      status: 'running',
      summary: mode === 'full' ? 'running review + scripts' : 'running review checks',
      cwd,
    });

    const summary = await new VerificationRunner(cwd).run(mode);
    this.setVerificationState({
      status: summary.status,
      summary: summary.summary,
      cwd: summary.cwd,
    });

    return summary;
  }

  private verificationModeForPurpose(
    purpose: DelegationPurpose | undefined,
  ): VerificationMode {
    if (purpose === 'execution' || purpose === 'design') {
      return 'full';
    }

    if (purpose === 'review') {
      return 'checks';
    }

    return 'none';
  }

  private formatToolPolicySummary(): string {
    const policies = Object.entries(this.config?.tools.policies ?? {})
      .filter(([, value]) => isToolPolicy(value))
      .sort(([left], [right]) => left.localeCompare(right));

    if (policies.length === 0) {
      return 'Tool policies\nnone';
    }

    return [
      'Tool policies',
      ...policies.map(([name, value]) => `${name} · ${value}`),
    ].join('\n');
  }

  private formatNetworkTrustSummary(): string {
    const network = this.config?.tools.network;
    const allowed = network?.allowed_hosts ?? [];
    const denied = network?.denied_hosts ?? [];
    return [
      'Network trust',
      `ask on new host: ${network?.ask_on_new_host ? 'on' : 'off'}`,
      `allowed: ${allowed.length > 0 ? allowed.join(', ') : 'none'}`,
      `denied: ${denied.length > 0 ? denied.join(', ') : 'none'}`,
    ].join('\n');
  }

  private formatSecretTrustSummary(): string {
    const secrets = this.config?.tools.secrets;
    const paths = secrets?.protected_paths ?? [];
    const env = secrets?.protected_env ?? [];
    return [
      'Secret trust',
      `protected paths: ${paths.length > 0 ? paths.join(', ') : 'none'}`,
      `protected env: ${env.length > 0 ? env.join(', ') : 'none'}`,
    ].join('\n');
  }

  private async runPermissionsCommand(args: string[]): Promise<string> {
    const requested = args[0]?.trim().toLowerCase();
    if (!requested) {
      return [
        'Permissions',
        `current: ${this.permissionProfile}`,
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
        this.formatToolPolicySummary(),
        '',
        this.formatNetworkTrustSummary(),
        '',
        this.formatSecretTrustSummary(),
      ].join('\n');
    }

    if (requested === 'tools') {
      return this.formatToolPolicySummary();
    }

    if (requested === 'network') {
      const action = args[1]?.trim().toLowerCase() ?? '';
      const value = args[2]?.trim() ?? '';
      if (!action || action === 'status') {
        return this.formatNetworkTrustSummary();
      }
      if (action === 'allow') {
        if (!value) {
          return 'Usage: /permissions network allow <host>';
        }
        await this.addStringListConfigValue('tools.network.allowed_hosts', value);
        return this.formatNetworkTrustSummary();
      }
      if (action === 'deny') {
        if (!value) {
          return 'Usage: /permissions network deny <host>';
        }
        await this.addStringListConfigValue('tools.network.denied_hosts', value);
        return this.formatNetworkTrustSummary();
      }
      if (action === 'remove') {
        const target = args[2]?.trim().toLowerCase();
        const entry = args[3]?.trim() ?? '';
        if (target === 'allow') {
          if (!entry) {
            return 'Usage: /permissions network remove allow <host>';
          }
          await this.removeStringListConfigValue('tools.network.allowed_hosts', entry);
          return this.formatNetworkTrustSummary();
        }
        if (target === 'deny') {
          if (!entry) {
            return 'Usage: /permissions network remove deny <host>';
          }
          await this.removeStringListConfigValue('tools.network.denied_hosts', entry);
          return this.formatNetworkTrustSummary();
        }
        return 'Usage: /permissions network remove <allow|deny> <host>';
      }
      if (action === 'clear') {
        await this.setStringListConfigValue('tools.network.allowed_hosts', []);
        await this.setStringListConfigValue('tools.network.denied_hosts', []);
        return this.formatNetworkTrustSummary();
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
        this.config = await loadConfig();
        this.scheduleStatePush();
        return this.formatNetworkTrustSummary();
      }
      return 'Usage: /permissions network [status|allow <host>|deny <host>|remove <allow|deny> <host>|clear|ask-on-new-host <on|off>]';
    }

    if (requested === 'secrets') {
      const action = args[1]?.trim().toLowerCase() ?? '';
      const target = args[2]?.trim().toLowerCase() ?? '';
      const value = args[3]?.trim() ?? '';
      if (!action || action === 'status') {
        return this.formatSecretTrustSummary();
      }
      if (action === 'add') {
        if (target === 'path') {
          if (!value) {
            return 'Usage: /permissions secrets add path <pattern>';
          }
          await this.addStringListConfigValue('tools.secrets.protected_paths', value);
          return this.formatSecretTrustSummary();
        }
        if (target === 'env') {
          if (!value) {
            return 'Usage: /permissions secrets add env <NAME>';
          }
          await this.addStringListConfigValue('tools.secrets.protected_env', value);
          return this.formatSecretTrustSummary();
        }
        return 'Usage: /permissions secrets add <path|env> <value>';
      }
      if (action === 'remove') {
        if (target === 'path') {
          if (!value) {
            return 'Usage: /permissions secrets remove path <pattern>';
          }
          await this.removeStringListConfigValue('tools.secrets.protected_paths', value);
          return this.formatSecretTrustSummary();
        }
        if (target === 'env') {
          if (!value) {
            return 'Usage: /permissions secrets remove env <NAME>';
          }
          await this.removeStringListConfigValue('tools.secrets.protected_env', value);
          return this.formatSecretTrustSummary();
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
      await this.setConfiguredToolPolicy(name, policy);
      return [
        `Tool policy updated: ${name} -> ${policy}`,
        '',
        this.formatToolPolicySummary(),
      ].join('\n');
    }

    const nextProfile =
      requested === 'workspace' ? 'workspace-write'
        : requested === 'full' ? 'permissionless'
          : requested;

    if (!isPermissionProfile(nextProfile)) {
      return 'Usage: /permissions <plan|ask|workspace-write|permissionless>';
    }

    await this.setPermissionProfile(nextProfile);
    return `Permissions updated: ${nextProfile}`;
  }

  private async runTodoCommand(args: string[]): Promise<string> {
    const [action, ...rest] = args;
    const trimmedAction = action?.trim().toLowerCase() ?? '';

    if (!trimmedAction) {
      return this.formatPlanSummary();
    }

    if (trimmedAction === 'clear') {
      await this.clearPlan();
      return 'Plan cleared.';
    }

    if (trimmedAction === 'add') {
      const step = rest.join(' ').trim();
      if (!step) {
        return 'Usage: /todo add <step>';
      }
      await this.addPlanItem(step);
      return this.formatPlanSummary();
    }

    if (trimmedAction === 'doing' || trimmedAction === 'done' || trimmedAction === 'pending') {
      const stepOrId = rest.join(' ').trim();
      if (!stepOrId) {
        return `Usage: /todo ${trimmedAction} <step-or-id>`;
      }
      await this.updatePlanItem(stepOrId, {
        status: trimmedAction === 'doing'
          ? 'in_progress'
          : trimmedAction === 'done'
            ? 'completed'
            : 'pending',
      });
      return this.formatPlanSummary();
    }

    return 'Usage: /todo [add|doing|done|pending|clear] ...';
  }

  private formatArtifactSummary(): string {
    if (this.artifacts.length === 0) {
      return 'Artifacts: none';
    }

    return [
      'Artifacts',
      ...this.artifacts.slice(0, 8).flatMap((artifact, index) => {
        const lines = formatArtifactForInspector(artifact);
        return lines.map((line, lineIndex) =>
          lineIndex === 0 ? `${index + 1}. ${line}` : `   ${line}`,
        );
      }),
    ].join('\n');
  }

  private formatQueueSummary(): string {
    if (this.queuedPrompts.length === 0) {
      return 'Queue: empty';
    }

    return [
      'Queue',
      ...this.queuedPrompts.map((prompt, index) => `${index + 1}. ${previewText(prompt, 180)}`),
    ].join('\n');
  }

  private resolveQueueIndex(value: string): number {
    const index = Number.parseInt(value, 10);
    if (!Number.isFinite(index) || index < 1 || index > this.queuedPrompts.length) {
      throw new Error(`Queue item not found: ${value}`);
    }

    return index - 1;
  }

  private async runQueueCommand(args: string[]): Promise<string> {
    const [action, ...rest] = args;
    const command = action?.trim().toLowerCase() ?? '';

    if (!command) {
      return this.formatQueueSummary();
    }

    if (command === 'clear') {
      this.queuedPrompts = [];
      this.syncQueuedPrompts();
      return 'Queue cleared.';
    }

    if (command === 'drop') {
      const ref = rest[0]?.trim();
      if (!ref) {
        return 'Usage: /queue drop <index>';
      }
      const index = this.resolveQueueIndex(ref);
      const [removed] = this.queuedPrompts.splice(index, 1);
      this.syncQueuedPrompts();
      return `Dropped queue item ${index + 1}: ${previewText(removed ?? '', 120)}`;
    }

    if (command === 'promote') {
      const ref = rest[0]?.trim();
      if (!ref) {
        return 'Usage: /queue promote <index>';
      }
      const index = this.resolveQueueIndex(ref);
      const [prompt] = this.queuedPrompts.splice(index, 1);
      if (prompt) {
        this.queuedPrompts.unshift(prompt);
      }
      this.syncQueuedPrompts();
      return this.formatQueueSummary();
    }

    if (command === 'run') {
      const ref = rest[0]?.trim();
      if (!ref) {
        return 'Usage: /queue run <index>';
      }
      const index = this.resolveQueueIndex(ref);
      const [prompt] = this.queuedPrompts.splice(index, 1);
      this.syncQueuedPrompts();
      if (!prompt) {
        return `Queue item not found: ${ref}`;
      }
      if (this.state.loading && this.abortController) {
        this.queuedPrompts.unshift(prompt);
        this.syncQueuedPrompts();
        return `Queue item ${ref} promoted to run next.`;
      }
      await this.submit(prompt);
      return `Queue item ${ref} started.`;
    }

    return 'Usage: /queue [run|promote|drop|clear] ...';
  }

  private async listVisibleBackgroundJobs(scope: 'all' | 'current' = 'all'): Promise<BackgroundJobState[]> {
    if (!this.backgroundJobStore) {
      return this.backgroundJobs.slice();
    }

    try {
      const jobs =
        scope === 'current' && this.state.sessionId
          ? await this.backgroundJobStore.listBySession(this.state.sessionId)
          : await this.backgroundJobStore.list();
      return jobs.map((job) => this.backgroundCoordinator.mapStoredJobToState(job));
    } catch {
      return this.backgroundJobs.slice();
    }
  }

  private async formatJobsSummary(): Promise<string> {
    const jobs = await this.listVisibleBackgroundJobs('all');
    if (jobs.length === 0) {
      return 'Jobs: none';
    }

    const running = jobs.filter((job) => job.status === 'running').length;
    const done = jobs.filter((job) => job.status === 'done').length;
    const cancelled = jobs.filter((job) => job.status === 'cancelled').length;
    const error = jobs.filter((job) => job.status === 'error').length;

    return [
      'Jobs',
      `summary: ${running} running · ${done} done · ${cancelled} cancelled · ${error} error`,
      ...jobs.map((job, index) => {
        const detail = job.status === 'done'
          ? job.resultPreview ?? job.workspacePath ?? job.detail ?? null
          : job.detail ?? job.resultPreview ?? job.workspacePath ?? null;
        const progress = summarizeChecklistProgress(job.checklist);
        const suffix = [progress, detail ? previewText(detail, 96) : null].filter((part): part is string => Boolean(part)).join(' · ');
        return `${index + 1}. ${job.label} [${job.status}]${suffix ? ` · ${suffix}` : ''}`;
      }),
    ].join('\n');
  }

  private formatJobInspect(job: BackgroundJobState): string {
    const artifact = this.getArtifactById(job.artifactId);
    return [
      `Job ${job.id}`,
      `label: ${job.label}`,
      `kind: ${job.kind}`,
      `status: ${job.status}`,
      job.purpose ? `purpose: ${job.purpose}` : null,
      job.preferredMode ? `mode: ${HARNESS_MODES[job.preferredMode].label}` : null,
      job.strategy ? `strategy: ${job.strategy}` : null,
      job.reason ? `reason: ${job.reason}` : null,
      job.attempt && job.attempt > 0 ? `attempt: ${job.attempt}` : null,
      job.checklist.length > 0 ? `progress: ${summarizeChecklistProgress(job.checklist)}` : null,
      `started: ${new Date(job.startedAt).toISOString()}`,
      `updated: ${new Date(job.updatedAt).toISOString()}`,
      job.finishedAt ? `finished: ${new Date(job.finishedAt).toISOString()}` : null,
      job.detail ? `detail: ${job.detail}` : null,
      job.resultPreview ? `result: ${job.resultPreview}` : null,
      job.workspacePath ? `workspace: ${job.workspacePath}` : null,
      job.verificationSummary ? `verification: ${job.verificationSummary}` : null,
      ...(artifact
        ? ['artifact:', ...formatArtifactForInspector(artifact).map((line) => `  ${line}`)]
        : job.artifactTitle ? [`artifact: ${job.artifactTitle}`] : []),
      job.prompt ? `prompt: ${job.prompt}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n');
  }

  private formatJobResult(job: BackgroundJobState): string {
    const artifact = this.getArtifactById(job.artifactId);
    if (artifact) {
      return formatArtifactForInspector(artifact).join('\n');
    }

    if (job.verificationSummary) {
      return [
        `Job ${job.id}`,
        `verification: ${job.verificationSummary}`,
        job.detail ? `detail: ${job.detail}` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n');
    }

    return `Job ${job.id} has no stored result yet.`;
  }

  private formatJobLogs(job: BackgroundJobRecord): string {
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
            (item) =>
              `- [${item.status}] ${item.label}${item.owner ? ` · ${item.owner}` : ''}${item.detail ? ` · ${previewText(item.detail, 120)}` : ''}`,
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
  }

  private async getStoredBackgroundJob(jobId: string): Promise<BackgroundJobRecord | null> {
    if (!this.backgroundJobStore) {
      return null;
    }

    try {
      return await this.backgroundJobStore.load(jobId);
    } catch {
      return null;
    }
  }

  private async waitForJobCompletion(jobId: string, timeoutMs: number): Promise<boolean> {
    if (!this.backgroundJobStore) {
      return false;
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const stored = await this.getStoredBackgroundJob(jobId);
      if (!stored) {
        return false;
      }
      if (stored.status === 'done' || stored.status === 'error' || stored.status === 'cancelled') {
        return true;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
    }

    return false;
  }

  private async resolveBackgroundJob(reference: string): Promise<BackgroundJobState> {
    const visibleJobs = (await this.listVisibleBackgroundJobs('all'))
      .slice()
      .sort((a, b) => {
        const priority = (job: BackgroundJobState): number => {
          if (job.status === 'running') {
            return 0;
          }
          if (job.status === 'cancelled') {
            return 1;
          }
          if (job.status === 'error') {
            return 2;
          }
          return 3;
        };
        return priority(a) - priority(b) || b.updatedAt - a.updatedAt;
      });

    const numeric = Number.parseInt(reference, 10);
    if (Number.isFinite(numeric) && numeric >= 1 && numeric <= visibleJobs.length) {
      return visibleJobs[numeric - 1]!;
    }

    const direct = visibleJobs.find((job) => job.id === reference || job.id.startsWith(reference));
    if (direct) {
      return direct;
    }

    throw new Error(`Job not found: ${reference}`);
  }

  private async runJobsCommand(args: string[]): Promise<string> {
    const [action, ...rest] = args;
    const command = action?.trim().toLowerCase() ?? '';

    if (!command) {
      return this.formatJobsSummary();
    }

    if (command === 'cancel') {
      const ref = rest[0]?.trim();
      if (!ref) {
        return 'Usage: /jobs cancel <index-or-id>';
      }
      const job = await this.resolveBackgroundJob(ref);
      const stored = await this.getStoredBackgroundJob(job.id);
      if (job.status !== 'running' || !stored?.pid) {
        return `Job ${ref} is not cancellable.`;
      }
      try {
        process.kill(stored.pid, 'SIGTERM');
      } catch {
        await this.backgroundJobStore?.update(job.id, {
          status: 'cancelled',
          detail: 'cancelled by user',
          finishedAt: Date.now(),
          pid: null,
        });
      }
      const cancelled = await this.waitForJobCompletion(job.id, 2_000);
      await this.pollBackgroundJobs();
      return cancelled
        ? `Cancelled job ${ref}.`
        : `Cancellation signal sent to job ${ref}; waiting for worker shutdown.`;
    }

    if (command === 'retry') {
      const ref = rest[0]?.trim();
      if (!ref) {
        return 'Usage: /jobs retry <index-or-id>';
      }
      const job = await this.resolveBackgroundJob(ref);
      if (!this.canStartBackgroundJob()) {
        return 'Retry unavailable: background capacity full.';
      }
      if (!job.prompt) {
        return `Job ${ref} cannot be retried.`;
      }
      if (job.kind === 'team') {
        await this.startBackgroundTeamRun(job.strategy ?? 'parallel', job.prompt, {
          routeNote: `Team run retry · ${job.strategy ?? 'parallel'}`,
          attempt: (job.attempt ?? 0) + 1,
        });
      } else {
        const decision: AutoRouteDecision = {
          kind: 'delegate',
          purpose: job.purpose && job.purpose !== 'general' ? job.purpose : 'general',
          preferredMode: job.preferredMode ?? undefined,
          reason: 'manual retry',
          repairAttempt: (job.attempt ?? 0) + 1,
        };
        await this.startBackgroundDelegatedRoute(
          {
            id: randomUUID(),
            role: 'user',
            content: job.prompt,
            timestamp: Date.now(),
          },
          decision,
        );
      }
      return `Retried job ${ref} in background.`;
    }

    if (command === 'inspect') {
      const ref = rest[0]?.trim();
      if (!ref) {
        return 'Usage: /jobs inspect <index-or-id>';
      }
      const job = await this.resolveBackgroundJob(ref);
      const stored = await this.getStoredBackgroundJob(job.id);
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
      return this.formatJobInspect(job);
    }

    if (command === 'logs') {
      const ref = rest[0]?.trim();
      if (!ref) {
        return 'Usage: /jobs logs <index-or-id>';
      }
      const job = await this.resolveBackgroundJob(ref);
      const stored = await this.getStoredBackgroundJob(job.id);
      if (!stored) {
        return `Job ${ref} has no stored logs.`;
      }
      return this.formatJobLogs(stored);
    }

    if (command === 'result') {
      const ref = rest[0]?.trim();
      if (!ref) {
        return 'Usage: /jobs result <index-or-id>';
      }
      const job = await this.resolveBackgroundJob(ref);
      const stored = await this.getStoredBackgroundJob(job.id);
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
      return this.formatJobResult(job);
    }

    if (command === 'promote') {
      const ref = rest[0]?.trim();
      if (!ref) {
        return 'Usage: /jobs promote <index-or-id>';
      }
      const job = await this.resolveBackgroundJob(ref);
      if (!job.prompt) {
        return `Job ${ref} cannot be promoted.`;
      }

      if (job.status === 'running' && job.controller) {
        job.controller.abort();
      } else {
        const stored = await this.getStoredBackgroundJob(job.id);
        if (stored?.pid) {
          try {
            process.kill(stored.pid, 'SIGTERM');
          } catch {
            // Process may already be gone; promote anyway.
          }
          await this.backgroundJobStore?.update(job.id, {
            status: 'error',
            detail: 'promoted to foreground',
            finishedAt: Date.now(),
            pid: null,
          });
          await this.pollBackgroundJobs();
        }
      }

      if (this.state.loading && this.abortController) {
        return 'Promote unavailable while a foreground request is active.';
      }

      if (job.kind === 'team') {
        await this.executeTeamRun(job.strategy ?? 'parallel', job.prompt, {
          routeNote: `Team run promoted · ${job.strategy ?? 'parallel'}`,
        });
      } else {
        await this.submit(job.prompt);
      }
      return `Promoted job ${ref} to foreground.`;
    }

    return 'Usage: /jobs [cancel|retry|inspect|logs|result|promote] ...';
  }

  private async runCheckpointCommand(message: string): Promise<string> {
    if (!this.config?.git_checkpoint) {
      return 'Checkpointing disabled in config.';
    }

    const git = new GitCheckpoint(process.cwd());
    if (!(await git.isAvailable())) {
      return 'Checkpoint unavailable: not a git repository.';
    }

    const hash = await git.checkpoint(message || 'checkpoint');
    return hash ? `Checkpoint created: ${hash.slice(0, 8)}` : 'Checkpoint skipped: no changes to commit.';
  }

  private async runUndoCommand(): Promise<string> {
    const git = new GitCheckpoint(process.cwd());
    if (!(await git.isAvailable())) {
      return 'Undo unavailable: not a git repository.';
    }

    const success = await git.undo();
    return success ? 'Reverted last ddudu checkpoint.' : 'No ddudu checkpoint to undo.';
  }

  private async seedSessionMessages(
    sessionId: string,
    messages: NativeMessageState[],
    mode: NamedMode = this.currentMode,
  ): Promise<void> {
    await this.workflowStateStore.seedSessionMessages(sessionId, messages, mode);
    await this.persistWorkflowState('seed_session', sessionId);
  }

  private async runForkCommand(name: string): Promise<string> {
    if (!this.sessionManager) {
      return 'Fork unavailable: no session manager.';
    }

    const parentId = this.state.sessionId ?? undefined;
    const session = await this.sessionManager.create({
      parentId,
      provider: this.getCurrentProvider(),
      model: this.getCurrentModel(),
      title: name.trim() || `fork:${this.currentMode}`,
      metadata: {
        mode: this.currentMode,
      },
    });
    await this.seedSessionMessages(session.id, this.state.messages);
    this.state.sessionId = session.id;
    await this.restoreEpistemicState();
    this.appendSystemMessage(`Forked session ${session.id.slice(0, 8)} from parent ${parentId?.slice(0, 8) ?? 'none'}.`);
    void this.persistWorkflowState('fork');
    return `Forked to new session: ${session.id}`;
  }

  private async runHandoffCommand(goal: string): Promise<string> {
    if (!this.sessionManager) {
      return 'Handoff unavailable: no session manager.';
    }

    const trimmedGoal = goal.trim();
    if (!trimmedGoal) {
      return 'Usage: /handoff <goal>';
    }

    const handoff = await this.compactionEngine.handoff(trimmedGoal, toCompactionMessages(this.state.messages));
    const session = await this.sessionManager.create({
      parentId: this.state.sessionId ?? undefined,
      provider: this.getCurrentProvider(),
      model: this.getCurrentModel(),
      title: `handoff:${trimmedGoal.slice(0, 48)}`,
      metadata: {
        mode: this.currentMode,
      },
    });

    const now = Date.now();
    const nextMessages: NativeMessageState[] = [
      {
        id: randomUUID(),
        role: 'system',
        content: `Handoff created from previous session. Goal: ${trimmedGoal}`,
        timestamp: now,
      },
      {
        id: randomUUID(),
        role: 'user',
        content: handoff.summary,
        timestamp: now + 1,
      },
      {
        id: randomUUID(),
        role: 'assistant',
        content: 'Handoff loaded. Continue from this compact context.',
        timestamp: now + 2,
      },
    ];

    await this.seedSessionMessages(session.id, nextMessages);
    this.state.sessionId = session.id;
    this.state.messages = nextMessages;
    this.remoteSessions.clear();
    this.updateRemoteSessionState();
    await this.restoreEpistemicState();
    void this.persistWorkflowState('handoff');
    this.scheduleStatePush();
    return [
      `Handoff created: ${session.id}`,
      `Relevant files: ${handoff.relevantFiles.join(', ') || 'none'}`,
      '',
      handoff.summary,
    ].join('\n');
  }

  private async runBriefingCommand(): Promise<string> {
    const artifactDir = this.getSessionArtifactDirectory();
    if (!artifactDir) {
      return 'Briefing unavailable: no active session.';
    }

    const briefing = generateBriefing(toCompactionMessages(this.state.messages), this.epistemicState.getState());
    await saveBriefing(briefing, artifactDir);
    this.invalidateDerivedCaches({ briefing: true });
    await this.epistemicState.save(artifactDir);
    return formatBriefing(briefing);
  }

  private async runDriftCommand(): Promise<string> {
    const artifactDir = this.getSessionArtifactDirectory();
    if (!artifactDir) {
      return 'Drift check unavailable: no active session.';
    }

    const briefing = await loadBriefing(artifactDir);
    if (!briefing) {
      return 'Drift check unavailable: run /briefing first.';
    }

    const detector = new DriftDetector(process.cwd());
    return detector.formatReport(await detector.detect(briefing));
  }

  private formatMcpSummary(): string {
    const entries = Object.entries(this.config?.mcp.servers ?? {});
    const paths = getDduduPaths(process.cwd());
    if (entries.length === 0) {
      return [
        'No MCP servers configured.',
        `project config: ${paths.projectConfig}`,
        `global config: ${paths.globalConfig}`,
        'Add servers under mcp.servers in ddudu config, not .claude/, unless you explicitly want Claude Code config.',
      ].join('\n');
    }

    const connected = new Set(this.mcpManager?.getConnectedServers() ?? []);
    const toolCount = this.toolRegistry
      ?.list()
      .filter((tool) => tool.name.startsWith('mcp__')).length ?? 0;

    return [
      'MCP servers',
      `project config: ${paths.projectConfig}`,
      `global config: ${paths.globalConfig}`,
      `connected: ${connected.size}/${entries.length}`,
      `tools: ${toolCount}`,
      ...entries.map(([name, config]) => {
        const enabled = config.enabled === false ? 'disabled' : connected.has(name) ? 'connected' : 'disconnected';
        const trust = isTrustTier(config.trust) ? config.trust : 'trusted';
        return `${name} · ${config.command} · ${enabled} · trust=${trust}`;
      }),
    ].join('\n');
  }

  private formatHookSummary(): string {
    const stats = this.hookRegistry.stats();
    const lines = Object.entries(stats).map(([event, count]) => `${event} · ${count}`);
    return ['Hooks', ...lines].join('\n');
  }

  private async runMcpCommand(args: string[]): Promise<string> {
    const command = args[0]?.trim().toLowerCase() ?? '';
    if (!command || command === 'status' || command === 'list') {
      return this.formatMcpSummary();
    }

    if (command === 'path') {
      const paths = getDduduPaths(process.cwd());
      return [
        'MCP config paths',
        `project: ${paths.projectConfig}`,
        `global: ${paths.globalConfig}`,
      ].join('\n');
    }

    if (command === 'reload') {
      await this.reloadMcpRuntime();
      return this.formatMcpSummary();
    }

    if (command === 'add') {
      const name = args[1]?.trim();
      const executable = args[2]?.trim();
      const commandArgs = args.slice(3).map((value) => value.trim()).filter(Boolean);
      if (!name || !executable) {
        return 'Usage: /mcp add <name> <command> [args...]';
      }
      await setDduduConfigValue(process.cwd(), `mcp.servers.${name}`, {
        command: executable,
        args: commandArgs,
        enabled: true,
      });
      await this.reloadMcpRuntime();
      return `Added MCP server ${name}.\n\n${this.formatMcpSummary()}`;
    }

    if (command === 'enable' || command === 'disable') {
      const name = args[1]?.trim();
      if (!name) {
        return `Usage: /mcp ${command} <name>`;
      }
      await this.setMcpServerEnabled(name, command === 'enable');
      return `${command === 'enable' ? 'Enabled' : 'Disabled'} MCP server ${name}.\n\n${this.formatMcpSummary()}`;
    }

    if (command === 'remove') {
      const name = args[1]?.trim();
      if (!name) {
        return 'Usage: /mcp remove <name>';
      }
      if (!this.config?.mcp.servers[name]) {
        return `Unknown MCP server: ${name}`;
      }
      await deleteDduduConfigValue(process.cwd(), `mcp.servers.${name}`);
      await this.reloadMcpRuntime();
      return `Removed MCP server ${name}.\n\n${this.formatMcpSummary()}`;
    }

    if (command === 'trust') {
      const name = args[1]?.trim();
      const trust = args[2]?.trim().toLowerCase();
      if (!name || !trust || !isTrustTier(trust)) {
        return 'Usage: /mcp trust <name> <trusted|ask|deny>';
      }
      if (!this.config?.mcp.servers[name]) {
        return `Unknown MCP server: ${name}`;
      }
      await this.setMcpServerTrust(name, trust);
      return `Updated MCP trust for ${name} -> ${trust}.\n\n${this.formatMcpSummary()}`;
    }

    return 'Usage: /mcp [status|list|path|reload|add <name> <command> [args...]|enable <name>|disable <name>|remove <name>|trust <name> <trusted|ask|deny>]';
  }

  private async runHookCommand(args: string[]): Promise<string> {
    const command = args[0]?.trim().toLowerCase() ?? '';
    if (!command || command === 'status' || command === 'list') {
      return this.formatHookSummary();
    }

    if (command === 'reload') {
      this.hookRegistry.clear();
      await loadHookFiles(process.cwd(), this.hookRegistry);
      this.scheduleStatePush();
      return this.formatHookSummary();
    }

    return 'Usage: /hook [status|list|reload]';
  }

  private formatTeamSummary(): string {
    const availableModes = this.getTeamEligibleModes();
    return [
      'Team',
      `orchestrator: ${availableModes.length > 0 ? 'ready' : 'unavailable'}`,
      'strategies: parallel, sequential, delegate',
      `available modes: ${availableModes.map((mode) => HARNESS_MODES[mode].label).join(', ') || 'none'}`,
      this.teamRunStrategy && this.teamRunTask
        ? `running: ${this.teamRunStrategy} · ${previewText(this.teamRunTask, 72)}`
        : 'running: no active team run',
      this.teamLastSummary ? `last: ${this.teamLastSummary}` : 'last: no completed team run yet',
      'usage: /team run [parallel|sequential|delegate] <task>',
    ].join('\n');
  }

  private getTeamEligibleModes(): NamedMode[] {
    return this.createDelegationRuntime().listAvailableModes();
  }

  private async runTeamCommand(args: string[]): Promise<string> {
    if (args.length === 0 || args[0] === 'status') {
      return this.formatTeamSummary();
    }

    if (args[0] !== 'run') {
      return 'Usage: /team run [parallel|sequential|delegate] <task>';
    }

    const strategyToken = args[1];
    const strategy =
      strategyToken === 'parallel' || strategyToken === 'sequential' || strategyToken === 'delegate'
        ? strategyToken
        : 'parallel';
    const taskStartIndex = strategyToken === strategy ? 2 : 1;
    const task = args.slice(taskStartIndex).join(' ').trim();
    if (!task) {
      return 'Usage: /team run [parallel|sequential|delegate] <task>';
    }

    if (this.state.loading || this.abortController) {
      if (!this.canStartBackgroundJob()) {
        return 'Team run unavailable: background capacity full.';
      }
      await this.startBackgroundTeamRun(strategy, task, {
        routeNote: `Team run background · ${strategy}`,
      });
      return `Team run started in background · ${strategy}`;
    }

    return this.executeTeamRun(strategy, task);
  }

  private async executeTeamRun(
    strategy: 'parallel' | 'sequential' | 'delegate',
    task: string,
    options: { routeNote?: string } = {},
  ): Promise<string> {
    if (this.state.loading || this.abortController) {
      return 'Team run unavailable while another request is active.';
    }
    this.resetEphemeralAgentActivities();

    const teamPlan = this.createTeamExecutionPlan(task, strategy);
    const teamAgents = teamPlan?.agents ?? [];
    if (teamAgents.length < 2 || !teamPlan) {
      return 'Team run unavailable: need at least one lead and one worker with valid auth.';
    }
    this.rememberTeamPlanArtifact(strategy, task, teamPlan.allocation);
    const runId = randomUUID();
    for (const agent of teamAgents.filter((item) => isRunnableTeamAgent(item))) {
      this.updateAgentActivity({
        id: `team:${runId}:queued:${agent.id}`,
        label: formatTeamAgentLabel(agent),
        status: 'queued',
        mode: agent.mode,
        purpose: teamAgentPurpose(agent),
        detail: `${strategy} · ${formatTeamAgentDetail(agent, agent.roleProfile ?? agent.role)}`,
      });
    }

    const assistantMessageId = randomUUID();
    this.state.messages.push({
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    });
    this.state.loading = true;
    this.state.loadingLabel = `team · ${strategy}`;
    this.state.loadingSince = Date.now();
    this.state.requestEstimate = null;
    this.activeAssistantMessageId = assistantMessageId;
    this.activeOperation = 'team';
    this.teamRunSince = Date.now();
    this.teamRunStrategy = strategy;
    this.teamRunTask = task;
    this.syncTeamRunState();
    this.teamRunIsolatedNotes.length = 0;
    this.scheduleStatePush();

    const controller = new AbortController();
    this.abortController = controller;
    const runStartedAt = Date.now();
    let lastVisibleTeamUpdateAt = runStartedAt;
    const publishTeamLiveStatus = (force: boolean = false): void => {
      const now = Date.now();
      if (!force && now - lastVisibleTeamUpdateAt < 10_000) {
        return;
      }
      const currentActivities = this.agentActivities.filter((activity) => activity.id.startsWith(`team:${runId}:`));
      this.updateMessage(
        assistantMessageId,
        this.teamExecutionCoordinator.formatLiveStatus({
          strategy,
          task,
          elapsedMs: now - runStartedAt,
          agentActivities: currentActivities,
        }),
      );
      lastVisibleTeamUpdateAt = now;
    };
    publishTeamLiveStatus(true);
    const liveStatusHeartbeat = setInterval(() => {
      if (controller.signal.aborted || this.activeAssistantMessageId !== assistantMessageId) {
        return;
      }
      publishTeamLiveStatus(false);
    }, 5_000);

    try {
      const result = await this.teamExecutionCoordinator.run({
        name: 'ddudu-native-team',
        task,
        strategy,
        agents: teamAgents,
        maxRounds: 2,
        sharedContext: `cwd=${process.cwd()} · mode=${this.currentMode} · model=${this.getCurrentModel()}`,
        signal: controller.signal,
        runAgent: async (agent, input, round) =>
          this.executeTeamAgent(agent, input, round, controller.signal, runId, this.teamRunIsolatedNotes),
        onMessage: (message) => {
          lastVisibleTeamUpdateAt = Date.now();
          this.updateMessage(
            assistantMessageId,
            this.teamExecutionCoordinator.formatProgress(message),
          );
        },
      });
      const formatted = this.teamExecutionCoordinator.formatResult({
        strategy,
        task,
        agents: teamAgents,
        messages: result.messages,
        output: result.output,
        success: result.success,
        rounds: result.rounds,
        isolatedNotes: this.teamRunIsolatedNotes,
      });
      this.teamLastSummary = `${strategy} · ${result.success ? 'ok' : 'incomplete'} · ${result.rounds} rounds`;
      this.finishMessage(assistantMessageId, formatted);
      this.rememberTeamArtifact(strategy, task, result.output, this.teamRunIsolatedNotes);
      if (this.sessionManager && this.state.sessionId) {
        await this.sessionManager.append(this.state.sessionId, {
          type: 'message',
          timestamp: new Date().toISOString(),
          data: {
            user: task,
            assistant: formatted,
            mode: this.currentMode,
            requestMode: 'team',
            teamStrategy: strategy,
            teamAgents: teamAgents.map((agent) => ({
              id: agent.id,
              mode: agent.mode,
              model: agent.model,
            })),
            isolatedRuns: [...this.teamRunIsolatedNotes],
          },
        });
      }
      return `Team run finished · ${this.teamLastSummary}`;
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        this.teamLastSummary = `${strategy} · aborted`;
        return 'Team run aborted.';
      }
      const message = `Team run failed: ${serializeError(error)}`;
      this.finishMessage(assistantMessageId, message);
      return message;
    } finally {
      clearInterval(liveStatusHeartbeat);
      this.state.loading = false;
      this.state.loadingLabel = '';
      this.state.loadingSince = null;
      this.state.requestEstimate = null;
      this.abortController = null;
      this.activeAssistantMessageId = null;
      this.activeOperation = null;
      this.teamRunSince = null;
      this.teamRunStrategy = null;
      this.teamRunTask = null;
      this.syncTeamRunState();
      this.scheduleStatePush();
    }
  }

  private async startBackgroundTeamRun(
    strategy: 'parallel' | 'sequential' | 'delegate',
    task: string,
    options: { routeNote?: string; attempt?: number } = {},
  ): Promise<void> {
    const teamPlan = this.createTeamExecutionPlan(task, strategy);
    const teamAgents = teamPlan?.agents ?? [];
    if (teamAgents.length < 2 || !teamPlan) {
      this.appendSystemMessage('Team run unavailable: need at least one lead and one worker with valid auth.');
      return;
    }

    if (!this.backgroundJobStore) {
      this.appendSystemMessage('[jobs] Background worker unavailable.');
      return;
    }

    const backgroundJobId = randomUUID();
    const teamPurpose = this.inferPromptPurpose(task);
    const contextSnapshot = await this.buildPromptContextSnapshot(
      task,
      teamPurpose,
      this.getPromptContextSnapshotOptions(task, teamPurpose, 'team'),
    );
    const planArtifact = this.rememberTeamPlanArtifact(strategy, task, teamPlan.allocation);
    const purposeArtifactLimit = teamPurpose === 'research' && this.isLikelyExternalResearchPrompt(task) ? 1 : 4;
    const artifacts = [
      planArtifact,
      ...this.getArtifactsForPurpose(teamPurpose, purposeArtifactLimit).filter((item) => item.id !== planArtifact.id),
    ];
    const checklist = buildTeamJobChecklist(teamAgents, strategy);
    const record = await this.backgroundJobStore.create({
      id: backgroundJobId,
      sessionId: this.state.sessionId,
      kind: 'team',
      label: `team ${strategy}`,
      cwd: process.cwd(),
      prompt: task,
      purpose: teamPurpose,
      preferredMode: null,
      preferredModel: null,
      strategy,
      reason: options.routeNote ?? `team ${strategy}`,
      attempt: options.attempt ?? 0,
      verificationMode: this.verificationModeForPurpose(teamPurpose),
      contextSnapshot,
      artifacts,
      teamAgents,
      teamSharedContext: `cwd=${process.cwd()} · mode=${this.currentMode} · model=${this.getCurrentModel()}`,
      checklist,
      agentActivities: teamAgents.filter((agent) => isRunnableTeamAgent(agent)).map((agent) => ({
        id: `job:${backgroundJobId}:${agent.id}:queued`,
        label: formatTeamAgentLabel(agent),
        mode: agent.mode ?? null,
        purpose: teamAgentPurpose(agent),
        checklistId: `agent:${agent.id}`,
        status: 'queued',
        detail: formatChecklistLinkedDetail(
          checklist,
          `agent:${agent.id}`,
          `${strategy} · ${formatTeamAgentDetail(agent, agent.roleProfile ?? agent.role)}`,
        ),
        workspacePath: null,
        updatedAt: Date.now(),
      })),
      result: null,
      artifact: null,
    });

    this.backgroundJobs = [this.backgroundCoordinator.mapStoredJobToState(record), ...this.backgroundJobs.filter((job) => job.id !== record.id)];
    this.syncBackgroundJobs();
    const live = this.agentActivities.filter((activity) => !activity.id.startsWith('job:'));
    this.agentActivities = [...live, ...this.backgroundCoordinator.collectDetachedAgentActivities([record])];
    this.syncAgentActivities();
    this.scheduleStatePush();

    try {
      await this.spawnDetachedBackgroundJob(record.id);
      await this.pollBackgroundJobs();
    } catch (error: unknown) {
      await this.backgroundJobStore.update(record.id, {
        status: 'error',
        detail: serializeError(error),
        finishedAt: Date.now(),
      });
      await this.pollBackgroundJobs();
      throw error;
    }
  }

  private createTeamExecutionPlan(
    task: string,
    strategy: 'parallel' | 'sequential' | 'delegate',
  ): { allocation: WorkAllocationPlan; agents: TeamAgentRole[] } | null {
    const draft = createTeamExecutionPlanDraft(task, strategy, this.getTeamEligibleModes());
    if (!draft) {
      return null;
    }
    return this.teamExecutionCoordinator.createPlan({
      draft,
      resolveRuntime: (mode) => this.getResolvedModeRuntime(mode),
      orchestratorPrompt: this.orchestratorPrompt,
    });
  }

  private buildTeamAgents(task: string, strategy: 'parallel' | 'sequential' | 'delegate'): TeamAgentRole[] {
    return this.createTeamExecutionPlan(task, strategy)?.agents ?? [];
  }

  private async executeTeamAgent(
    agent: TeamAgentRole,
    input: string,
    round: number,
    signal: AbortSignal,
    runId: string,
    isolatedNotes: string[],
  ): Promise<string> {
    const runtime = this.createDelegationRuntime();
    const queuedActivityId = `team:${runId}:queued:${agent.id}`;
    this.agentActivities = this.agentActivities.filter((activity) => activity.id !== queuedActivityId);
    this.syncAgentActivities();
    const activityId = `team:${runId}:${round}:${agent.id}`;
    const purpose: DelegationPurpose = teamAgentPurpose(agent);
    this.updateAgentActivity({
      id: activityId,
      label: formatTeamAgentLabel(agent),
      status: 'running',
      mode: agent.mode,
      purpose,
      detail: formatTeamAgentDetail(agent, `round ${round} · ${agent.roleProfile ?? agent.role}`),
    });
    try {
      const contextSnapshot = await this.buildPromptContextSnapshot(
        input,
        purpose,
        this.getPromptContextSnapshotOptions(input, purpose, 'team'),
      );
      const artifactLimit = purpose === 'research' && this.isLikelyExternalResearchPrompt(input) ? 1 : 4;
      const artifacts = this.getArtifactsForPurpose(purpose, artifactLimit);
      const result = await runTeamAgentDelegation({
        runtime,
        agent,
        input,
        round,
        signal,
        maxTokens: this.config ? getMaxTokens(this.config) : undefined,
        parentSessionId: this.state.sessionId,
        cwd: process.cwd(),
        contextSnapshot,
        artifacts,
        onApiCallStart: async (input) => {
          await this.hookRegistry.emit(
            'beforeApiCall',
            buildDelegationHookContext(input, {
              sessionId: this.state.sessionId,
              teamAgentId: agent.id,
              teamRound: round,
            }),
          );
        },
        onApiCallComplete: async (input) => {
          await this.hookRegistry.emit(
            'afterApiCall',
            buildDelegationHookContext(input, {
              sessionId: this.state.sessionId,
              teamAgentId: agent.id,
              teamRound: round,
            }),
          );
        },
        onText: (delta) => {
          if (delta.trim()) {
            this.updateAgentActivity({
              id: activityId,
              label: formatTeamAgentLabel(agent),
              status: 'running',
              mode: agent.mode,
              purpose,
              detail: previewText(delta, 64),
            });
          }
        },
        onToolState: (states) => {
          const activeTool = states.find((state) => state.status === 'running') ?? states[states.length - 1];
          if (activeTool) {
            this.updateAgentActivity({
              id: activityId,
              label: formatTeamAgentLabel(agent),
              status: 'running',
              mode: agent.mode,
              purpose,
              detail: `${activeTool.name} ${activeTool.status}`,
            });
          }
        },
        onVerificationState: (state) => {
          this.updateAgentActivity({
            id: activityId,
            label: formatTeamAgentLabel(agent),
            status:
              state.status === 'running'
                ? 'verifying'
                : state.status === 'passed' || state.status === 'skipped'
                  ? 'done'
                  : 'error',
            mode: agent.mode,
            purpose,
            detail: state.summary ?? null,
          });
        },
        onExecutionState: (detail) => {
          this.updateAgentActivity({
            id: activityId,
            label: formatTeamAgentLabel(agent),
            status: 'queued',
            mode: agent.mode,
            purpose,
            detail,
          });
        },
      });

      this.setWorkspaceState(result.workspace ?? null);
      if (result.verification) {
        this.setVerificationState({
          status: result.verification.status,
          summary: result.verification.summary,
          cwd: result.verification.cwd,
        });
      }
      if (result.workspace || result.verification) {
        isolatedNotes.push(
          [
            `- ${agent.name}`,
            result.workspace ? `workspace ${result.workspace.path}` : null,
            result.verification ? `verify ${result.verification.summary}` : null,
          ]
            .filter((part): part is string => Boolean(part))
            .join(' · '),
        );
      }
      this.updateAgentActivity({
        id: activityId,
        label: formatTeamAgentLabel(agent),
        status: 'done',
        mode: agent.mode,
        purpose,
        detail: result.verification?.summary ?? previewText(result.text, 64),
        workspacePath: result.workspace?.path ?? null,
      });

      return result.output;
    } catch (error: unknown) {
      this.updateAgentActivity({
        id: activityId,
        label: formatTeamAgentLabel(agent),
        status: 'error',
        mode: agent.mode,
        purpose,
        detail: serializeError(error),
      });
      throw error;
    }
  }

  private async runInitSummary(): Promise<string> {
    try {
      const result = await initializeProject();
      if (result.alreadyInitialized) {
        return `Already initialized: ${result.projectDir}`;
      }

      return [`Initialized ${result.projectDir}`, `Created: ${result.created.join(', ')}`].join('\n');
    } catch (error: unknown) {
      return `Init failed: ${serializeError(error)}`;
    }
  }

  private async compactContext(notice?: string, instructions?: string): Promise<void> {
    const messages = buildCompactionMessages(this.state.messages, this.getCompactionBuildOptions());
    if (messages.length === 0) {
      this.appendSystemMessage('Nothing to compact.');
      return;
    }

    try {
      const compacted = await this.compactionEngine.compact(messages, instructions);
      this.state.messages = [
        {
          id: randomUUID(),
          role: 'user',
          content: compacted,
          timestamp: Date.now(),
        },
        {
          id: randomUUID(),
          role: 'assistant',
          content: 'Context compacted. Ready to continue.',
          timestamp: Date.now(),
        },
      ];
      this.remoteSessions.clear();
      this.updateRemoteSessionState();

      if (this.sessionManager && this.state.sessionId) {
        await this.sessionManager.append(this.state.sessionId, {
          type: 'compaction',
          timestamp: new Date().toISOString(),
          data: {
            summary: compacted,
          },
        });
      }
      if (notice) {
        this.state.messages.push({
          id: randomUUID(),
          role: 'system',
          content: notice,
          timestamp: Date.now(),
        });
      }
      this.scheduleStatePush();
    } catch (error: unknown) {
      this.appendSystemMessage(`Compaction failed: ${serializeError(error)}`);
    }
  }

  private isCliBackedProvider(provider: string = this.getCurrentProvider()): boolean {
    return this.getProviderCapabilities(provider)?.executionMode === 'cli';
  }

  private getCanonicalConversationMessages(): NativeMessageState[] {
    return this.state.messages.filter(
      (message) => message.role === 'user' || message.role === 'assistant',
    );
  }

  private getCanonicalConversationCount(): number {
    return this.getCanonicalConversationMessages().length;
  }

  private updateRemoteSessionState(): void {
    const current = this.remoteSessions.get(this.getCurrentProvider()) ?? null;
    this.state.remoteSessionId = current?.sessionId ?? null;
    this.state.remoteSessionCount = this.remoteSessions.size;
  }

  private syncTeamRunState(): void {
    this.state.teamRunStrategy = this.teamRunStrategy;
    this.state.teamRunTask = this.teamRunTask;
    this.state.teamRunSince = this.teamRunSince;
  }

  private rememberRemoteSession(session: CliBackedSessionState): void {
    this.remoteSessions.set(session.provider, session);
    this.updateRemoteSessionState();
    void this.persistWorkflowState('remote_session_update');
    this.scheduleStatePush();
  }

  private invalidateRemoteSession(provider: string): void {
    this.remoteSessions.delete(provider);
    this.updateRemoteSessionState();
    void this.persistWorkflowState('remote_session_invalidate');
  }

  private async prepareRequestPlan(
    userMessage: NativeMessageState,
    forceFresh: boolean = false,
  ): Promise<RequestPlan> {
    const provider = this.getCurrentProvider();
    const capabilities = this.getProviderCapabilities(provider);
    const bridgeSession = !forceFresh ? this.remoteSessions.get(provider) : undefined;
    const canonicalMessages = this.getCanonicalConversationMessages();

    if (capabilities?.supportsRemoteSession && bridgeSession) {
      const missingMessages = canonicalMessages.slice(bridgeSession.syncedMessageCount);
      if (missingMessages.length === 0) {
        return {
          apiMessages: [{ role: 'user', content: userMessage.content }],
          mode: 'resume',
          note: null,
          remoteSessionId: bridgeSession.sessionId,
        };
      }

      const hydrationPrompt = await this.buildHydrationPrompt(
        missingMessages,
        bridgeSession,
        userMessage.content,
      );
      return {
        apiMessages: [{ role: 'user', content: hydrationPrompt }],
        mode: 'hydrate',
        note: null,
        remoteSessionId: bridgeSession.sessionId,
      };
    }

    return {
      apiMessages: toApiMessages([...this.state.messages, userMessage]),
      mode: 'full',
      note: null,
      remoteSessionId: null,
    };
  }

  private async buildHydrationPrompt(
    missingMessages: NativeMessageState[],
    remoteSession: CliBackedSessionState,
    nextPrompt: string,
  ): Promise<string> {
    const profile = this.getContextProfile(remoteSession.provider, remoteSession.lastModel);
    const purpose = this.inferPromptPurpose(nextPrompt);
    const handoffArtifacts = this.getArtifactsForPurpose(purpose, 4);
    const compactionMessages = buildCompactionMessages(
      missingMessages,
      this.getCompactionBuildOptions(remoteSession.provider),
    );
    const delta =
      missingMessages.length <= profile.hydrateInlineMessages
        ? compactionMessages.map((message) => `[${message.role}] ${message.content}`).join('\n')
        : await this.compactionEngine.compact(compactionMessages, 'Sync this provider session to ddudu canonical context.');

    const artifactSection = handoffArtifacts.length > 0
      ? [
          '<handoff_artifacts>',
          ...handoffArtifacts.map((artifact) => formatArtifactForHandoff(artifact)),
          '</handoff_artifacts>',
          '',
        ].join('\n')
      : '';

    return [
      'ddudu canonical session has advanced while you were inactive.',
      `Resume the existing provider session and treat the following delta as authoritative context since session ${remoteSession.sessionId.slice(0, 8)}:`,
      '',
      'Use artifacts and stable signals first; treat transcript delta as supporting detail.',
      '',
      artifactSection,
      delta,
      '',
      'After syncing, answer this new user message:',
      nextPrompt,
    ].join('\n');
  }

  private applyToolStates(
    messageId: string,
    states: Array<{
      id: string;
      name: string;
      status: 'running' | 'done' | 'error';
      input?: Record<string, unknown>;
      result?: string;
    }>,
  ): void {
    if (states.length === 0) {
      return;
    }

    const message = this.state.messages.find((entry) => entry.id === messageId);
    const existing = new Map((message?.toolCalls ?? []).map((tool) => [tool.id, tool]));

    for (const state of states) {
      const current = existing.get(state.id);
      existing.set(state.id, {
        id: state.id,
        name: state.name,
        args: state.input ? JSON.stringify(state.input) : current?.args ?? '{}',
        summary:
          current?.summary ??
          summarizeToolInput(state.name, state.input ?? {}),
        status: state.status,
        result: state.result ? summarizeToolResult(state.result) : current?.result,
      });
    }

    this.updateMessage(messageId, message?.content ?? '', Array.from(existing.values()));
  }

  private updateMessage(id: string, content: string, toolCalls?: NativeToolCallState[]): void {
    this.state.messages = this.state.messages.map((message) => {
      if (message.id !== id) {
        return message;
      }

      return {
        ...message,
        content,
        toolCalls: toolCalls ?? message.toolCalls,
      };
    });
    this.scheduleStatePush();
  }

  private finishMessage(id: string, content: string): void {
    this.state.messages = this.state.messages.map((message) => {
      if (message.id !== id) {
        return message;
      }

      return {
        ...message,
        content,
        isStreaming: false,
      };
    });
    this.scheduleStatePush();
  }

  private setToolStatus(
    messageId: string,
    toolId: string,
    status: NativeToolCallState['status'],
    result?: string,
  ): void {
    this.state.messages = this.state.messages.map((message) => {
      if (message.id !== messageId || !message.toolCalls) {
        return message;
      }

      return {
        ...message,
        toolCalls: message.toolCalls.map((toolCall) => {
          if (toolCall.id !== toolId) {
            return toolCall;
          }

          return {
            ...toolCall,
            status,
            result: result ?? toolCall.result,
          };
        }),
      };
    });
    this.scheduleStatePush();
  }

  private emitStateNow(): void {
    this.syncUsageState();
    this.syncLspState();

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const nextState = {
      ...this.state,
      requestEstimate: this.state.requestEstimate ? { ...this.state.requestEstimate } : null,
      queuedPrompts: [...this.state.queuedPrompts],
      messages: this.state.messages.map((message) => ({
        ...message,
        toolCalls: message.toolCalls ? [...message.toolCalls] : undefined,
      })),
      providers: this.state.providers.map((provider) => ({ ...provider })),
      mcp: this.state.mcp
        ? {
            ...this.state.mcp,
            serverNames: [...this.state.mcp.serverNames],
            connectedNames: [...this.state.mcp.connectedNames],
          }
        : null,
      lsp: this.state.lsp
        ? {
            ...this.state.lsp,
            serverLabels: [...this.state.lsp.serverLabels],
            connectedLabels: [...this.state.lsp.connectedLabels],
          }
        : null,
      modes: this.state.modes.map((mode) => ({ ...mode })),
      slashCommands: this.state.slashCommands.map((command) => ({ ...command })),
      todos: this.state.todos.map((item) => ({ ...item })),
      backgroundJobs: this.state.backgroundJobs.map((job) => ({ ...job })),
      artifacts: this.state.artifacts.map((artifact) => ({ ...artifact })),
      askUser: this.state.askUser ? { ...this.state.askUser, options: [...this.state.askUser.options] } : null,
    };

    const serialized = JSON.stringify(nextState);
    if (serialized === this.lastEmittedStateSerialized) {
      return;
    }
    this.lastEmittedStateSerialized = serialized;

    this.emit({
      type: 'state',
      state: nextState,
    });
  }

  private scheduleStatePush(): void {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.emitStateNow();
    }, 16);
  }
}
