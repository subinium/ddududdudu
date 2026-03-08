import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import { DEFAULT_ANTHROPIC_BASE_URL } from '../../api/anthropic-base-url.js';
import type { ApiMessage, ContentBlock, ToolUseContentBlock } from '../../api/anthropic-client.js';
import { createClient, type ApiClient, type StreamEvent } from '../../api/client-factory.js';
import type { ToolResultBlock, ToolUseBlock } from '../../api/tool-executor.js';
import { formatToolsForApi } from '../../api/tool-executor.js';
import { discoverAllProviders, type ProviderAuth } from '../../auth/discovery.js';
import { ChecksRunner } from '../../core/checks.js';
import { loadConfig } from '../../core/config.js';
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
import { loadMemory } from '../../core/memory.js';
import { loadSystemPrompt } from '../../core/prompts.js';
import { SessionManager } from '../../core/session.js';
import { SkillLoader, type LoadedSkill } from '../../core/skill-loader.js';
import { TeamOrchestrator, type AgentRole as TeamAgentRole, type TeamMessage } from '../../core/team-agent.js';
import { TokenCounter } from '../../core/token-counter.js';
import type { DduduConfig, LoadedSession, NamedMode, SessionEntry } from '../../core/types.js';
import { type VerificationMode, type VerificationSummary, VerificationRunner } from '../../core/verifier.js';
import { type IsolatedWorkspace, WorktreeManager } from '../../core/worktree-manager.js';
import type {
  PermissionProfile,
  PlanItem,
  PlanItemStatus,
  WorkflowStateSnapshot,
} from '../../core/workflow-state.js';
import { McpManager, type McpServerConfig, type McpTool } from '../../mcp/client.js';
import type { ToolContext } from '../../tools/index.js';
import type { Tool, ToolParameter } from '../../tools/index.js';
import { ToolRegistry } from '../../tools/registry.js';
import { discoverToolboxTools } from '../../tools/toolbox.js';
import { BLACKPINK_MODES, BP_LYRICS, MODE_ORDER } from '../ink/theme.js';
import { SLASH_COMMANDS } from '../ink/types.js';
import {
  buildCompactionMessages,
  type CompactionBuildOptions,
  type BridgeRequestMode,
  type BridgeSessionState,
  countApiMessageTokens,
  createRequestEstimate,
} from './session-support.js';
import type {
  NativeBridgeEvent,
  NativeMessageState,
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
  mode: BridgeRequestMode;
  note: string | null;
  remoteSessionId: string | null;
}

interface AutoRouteDecision {
  kind: 'direct' | 'delegate' | 'team';
  reason: string;
  purpose?: DelegationPurpose;
  preferredMode?: NamedMode;
  strategy?: 'parallel' | 'sequential' | 'delegate';
}

type EmitFn = (event: NativeBridgeEvent) => void;
type AskUserResolver = {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
};

const MAX_TOOL_TURNS_FALLBACK = 25;
const PROVIDER_NAMES = ['anthropic', 'openai', 'gemini'] as const;
const PROMPT_VERSION = process.env.DDUDU_VERSION ?? '0.2.0';
const DEFAULT_PERMISSION_PROFILE: PermissionProfile = 'workspace-write';

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

const buildFallbackSystemPrompt = (mode: NamedMode, model?: string): string => {
  const modeConfig = BLACKPINK_MODES[mode] ?? BLACKPINK_MODES.jennie;
  const cwd = process.cwd();
  const projectName = basename(cwd) || 'unknown-project';

  return DEFAULT_SYSTEM_PROMPT
    .replace(/\$\{model\}/g, model ?? modeConfig.model)
    .replace(/\$\{provider\}/g, modeConfig.provider)
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

const isPlanStatus = (value: unknown): value is PlanItemStatus => {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
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
    case 'web_fetch':
    case 'WebFetch': {
      const url = previewText(readString(input.url), 72);
      return url ? `fetch ${url}` : 'fetch URL';
    }
    case 'WebSearch': {
      const query = previewText(readString(input.query), 60);
      return query ? `search ${query}` : 'web search';
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

const getEntryString = (entry: SessionEntry, key: string): string => {
  const value = entry.data[key];
  return typeof value === 'string' ? value : '';
};

const findModeForProviderModel = (
  provider: string | undefined,
  model: string | undefined,
): NamedMode | null => {
  if (!provider && !model) {
    return null;
  }

  for (const mode of MODE_ORDER) {
    const modeConfig = BLACKPINK_MODES[mode];
    if (!modeConfig) {
      continue;
    }

    if (provider && model) {
      if (modeConfig.provider === provider && modeConfig.model === model) {
        return mode;
      }
      continue;
    }

    if (provider && modeConfig.provider === provider) {
      return mode;
    }

    if (model && modeConfig.model === model) {
      return mode;
    }
  }

  return null;
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
    model: BLACKPINK_MODES.jennie.model,
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
    requestEstimate: null,
    queuedPrompts: [],
    providers: [],
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
    todos: [],
    workspace: null,
    verification: null,
    error: null,
  };

  private currentMode: NamedMode = 'jennie';
  private selectedModels: Record<NamedMode, string> = {
    jennie: BLACKPINK_MODES.jennie.model,
    lisa: BLACKPINK_MODES.lisa.model,
    'rosé': BLACKPINK_MODES['rosé'].model,
    jisoo: BLACKPINK_MODES.jisoo.model,
  };
  private availableProviders = new Map<string, ProviderCredentials>();
  private activeClient: ApiClient | null = null;
  private toolRegistry: ToolRegistry | null = null;
  private sessionManager: SessionManager | null = null;
  private mcpManager: McpManager | null = null;
  private readonly loadedSkills = new Map<string, LoadedSkill>();
  private tokenCounter = new TokenCounter(BLACKPINK_MODES.jennie.model);
  private systemPrompt = buildFallbackSystemPrompt('jennie');
  private permissionProfile: PermissionProfile = DEFAULT_PERMISSION_PROFILE;
  private lastSafePermissionProfile: PermissionProfile = DEFAULT_PERMISSION_PROFILE;
  private todos: PlanItem[] = [];
  private readonly epistemicState = new EpistemicStateManager();
  private abortController: AbortController | null = null;
  private activeOperation: 'request' | 'team' | null = null;
  private activeAssistantMessageId: string | null = null;
  private queuedPrompts: string[] = [];
  private pendingAskUser: AskUserResolver | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private teamRunSince: number | null = null;
  private teamRunStrategy: 'parallel' | 'sequential' | 'delegate' | null = null;
  private teamRunTask: string | null = null;
  private teamLastSummary: string | null = null;
  private readonly compactionEngine = new CompactionEngine();
  private readonly hookRegistry = new HookRegistry();
  private readonly remoteSessions = new Map<string, BridgeSessionState>();
  private readonly worktreeManager = new WorktreeManager(process.cwd());
  private readonly teamRunIsolatedNotes: string[] = [];

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
      this.selectedModels[modeName] = BLACKPINK_MODES[modeName].model;
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

    try {
      await loadHookFiles(process.cwd(), this.hookRegistry);
    } catch (error: unknown) {
      this.appendSystemMessage(`[hooks] ${serializeError(error)}`);
    }

    this.sessionManager = new SessionManager(this.config.session.directory);
    try {
      const resumed = await this.resumeRequestedSession();
      if (!resumed) {
        const session = await this.sessionManager.create({
          provider: this.getCurrentProvider(),
          model: this.getCurrentModel(),
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
    this.state.ready = true;
    this.emitStateNow();
  }

  public shutdown(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.state.sessionId) {
      void this.hookRegistry.emit('onSessionEnd', {
        sessionId: this.state.sessionId,
        provider: this.getCurrentProvider(),
        model: this.getCurrentModel(),
      });
    }
    this.mcpManager?.disconnectAll();
    this.abortCurrentRequest();
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
          'Available commands: /clear, /compact, /mode, /model, /plan, /todo, /permissions, /memory, /session, /config, /help, /doctor, /review, /checkpoint, /undo, /handoff, /fork, /briefing, /drift, /quit, /fire, /init, /skill, /hook, /mcp, /team',
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
      case '/review':
        this.appendSystemMessage(await this.runReviewSummary());
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
        this.appendSystemMessage(await this.formatSessionSummary());
        return;
      case '/memory':
        this.appendSystemMessage(await this.formatMemorySummary());
        return;
      case '/skill':
        if (rest.length === 0) {
          this.appendSystemMessage(await this.formatSkillSummary());
        } else {
          this.appendSystemMessage(await this.loadSkillSummary(rest.join(' ')));
        }
        return;
      case '/mcp':
        this.appendSystemMessage(this.formatMcpSummary());
        return;
      case '/hook':
        this.appendSystemMessage(this.formatHookSummary());
        return;
      case '/team':
        this.appendSystemMessage(await this.runTeamCommand(rest));
        return;
      case '/init':
        this.appendSystemMessage(await this.runInitSummary());
        return;
      case '/quit':
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

    if (this.activeOperation === 'request' && this.isBridgeBackedProvider()) {
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
      this.queuedPrompts.push(trimmedContent);
      this.state.queuedPrompts = [...this.queuedPrompts];
      this.scheduleStatePush();
      return;
    }

    const mode = this.currentMode;
    const model = this.getCurrentModel();
    await this.refreshSystemPrompt();
    this.tokenCounter.setModel(model);
    await this.maybeAutoCompact(trimmedContent);

    if (await this.maybeHandleJennieAutoRoute(trimmedContent)) {
      return;
    }

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

    const tools = this.toolRegistry ? formatToolsForApi(this.toolRegistry) : undefined;
    const maxTokens = this.config ? getMaxTokens(this.config) : undefined;

    let fullText = '';
    let done = false;
    let toolTurns = 0;
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
      let attempt = 0;

      while (!controller.signal.aborted) {
        const apiMessages = [...currentPlan.apiMessages];
        done = false;
        toolTurns = 0;

        try {
          while (!controller.signal.aborted && !done) {
            if (toolTurns >= maxToolTurns) {
              fullText = '[error] Maximum tool turns reached';
              this.finishMessage(assistantMessage.id, fullText);
              done = true;
              break;
            }

            const stream = this.activeClient.stream(apiMessages, {
              systemPrompt: this.systemPrompt,
              model,
              tools,
              signal: controller.signal,
              maxTokens,
              remoteSessionId: currentPlan.remoteSessionId ?? undefined,
              cwd: process.cwd(),
            });

            const outcome = await this.consumeStream(stream, {
              assistantMessageId: assistantMessage.id,
              apiMessages,
              currentText: fullText,
              requestInputTokens,
              requestOutputTokens,
              requestUncachedInputTokens,
              requestCachedInputTokens,
              requestCacheWriteInputTokens,
              signal: controller.signal,
              onSession: (sessionId: string) => {
                activeRemoteSessionId = sessionId;
                this.rememberRemoteSession({
                  provider: this.getCurrentProvider(),
                  sessionId,
                  lastModel: model,
                  lastUsedAt: Date.now(),
                  syncedMessageCount: this.getCanonicalConversationCount() - 1,
                });
              },
            });

            fullText = outcome.fullText;
            requestInputTokens = outcome.inputTokens;
            requestOutputTokens = outcome.outputTokens;
            requestUncachedInputTokens = outcome.uncachedInputTokens;
            requestCachedInputTokens = outcome.cachedInputTokens;
            requestCacheWriteInputTokens = outcome.cacheWriteInputTokens;
            done = outcome.done;

            if (!outcome.continueWithTools || controller.signal.aborted) {
              break;
            }

            toolTurns += 1;
          }

          break;
        } catch (error: unknown) {
          if (
            currentPlan.remoteSessionId &&
            attempt === 0 &&
            !controller.signal.aborted
          ) {
            this.invalidateRemoteSession(this.getCurrentProvider());
            currentPlan = await this.prepareRequestPlan(userMessage, true);
            this.state.requestEstimate = this.estimateRequestForPlan(currentPlan);
            fullText = '';
            requestInputTokens = 0;
            requestOutputTokens = 0;
            requestUncachedInputTokens = 0;
            requestCachedInputTokens = 0;
            requestCacheWriteInputTokens = 0;
            activeRemoteSessionId = currentPlan.remoteSessionId;
            this.updateMessage(assistantMessage.id, '');
            this.scheduleStatePush();
            attempt += 1;
            continue;
          }

          throw error;
        }
      }

      if (!controller.signal.aborted) {
        if (this.isBridgeBackedProvider() && activeRemoteSessionId) {
          this.rememberRemoteSession({
            provider: this.getCurrentProvider(),
            sessionId: activeRemoteSessionId,
            lastModel: model,
            lastUsedAt: Date.now(),
            syncedMessageCount: this.getCanonicalConversationCount(),
          });
        }

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

        this.state.loadingLabel = 'verifier';
        this.scheduleStatePush();
        const verification = await this.runAutoVerification(process.cwd(), 'full');
        if (verification.status !== 'skipped') {
          this.appendSystemMessage(`[verify] ${verification.summary}`);
        }
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        if (this.isBridgeBackedProvider()) {
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
      this.state.queuedPrompts = [...this.queuedPrompts];
      if (nextPrompt) {
        await this.submit(nextPrompt);
      }
    }
  }

  private classifyJennieAutoRoute(prompt: string): AutoRouteDecision {
    const normalized = normalizeSingleLine(prompt);
    const lower = normalized.toLowerCase();
    const wordCount = normalized.length > 0 ? normalized.split(/\s+/u).length : 0;

    const hasDesign = /\b(ui|ux|design|layout|spacing|typography|visual|a11y|accessibility|color|interaction)\b/u.test(lower);
    const hasPlanning = /\b(plan|planning|architecture|architect|strategy|roadmap|tradeoff|spec|design doc)\b/u.test(lower);
    const hasResearch = /\b(research|investigate|look into|survey|compare options|explore)\b/u.test(lower);
    const hasReview = /\b(review|audit|verify|validation|regression|risk|critic|critique)\b/u.test(lower);
    const hasExecution = /\b(implement|build|fix|write|edit|refactor|patch|ship|code|change)\b/u.test(lower);
    const explicitTeam = /\b(team|multi[- ]agent|orchestrate|delegate|parallel|sequential|split (this|it) up|break (this|it) down)\b/u.test(lower);
    const multiStep =
      /(\b(plan|research|review|design|implement|fix)\b.*\b(and|then|also)\b.*\b(plan|research|review|design|implement|fix)\b)/u.test(lower) ||
      /\b(end-to-end|from scratch|full flow|across the repo|whole project|entire codebase)\b/u.test(lower) ||
      normalized.split(/\n+/u).length > 1;
    const purposeCount = [hasDesign, hasPlanning, hasResearch, hasReview, hasExecution].filter(Boolean).length;

    if (wordCount <= 6 && purposeCount === 0) {
      return { kind: 'direct', reason: 'short direct prompt' };
    }

    if (explicitTeam || (purposeCount >= 2 && multiStep)) {
      return {
        kind: 'team',
        strategy: explicitTeam ? 'delegate' : 'parallel',
        reason: explicitTeam ? 'explicit orchestration request' : 'multi-domain request',
      };
    }

    if (hasDesign) {
      return {
        kind: 'delegate',
        purpose: 'design',
        preferredMode: 'jisoo',
        reason: 'design or UX request',
      };
    }

    if (hasResearch) {
      return {
        kind: 'delegate',
        purpose: 'research',
        preferredMode: 'rosé',
        reason: 'research request',
      };
    }

    if (hasPlanning) {
      return {
        kind: 'delegate',
        purpose: 'planning',
        preferredMode: 'rosé',
        reason: 'planning or architecture request',
      };
    }

    if (hasReview) {
      return {
        kind: 'delegate',
        purpose: 'review',
        preferredMode: 'rosé',
        reason: 'review or validation request',
      };
    }

    if (hasExecution) {
      return {
        kind: 'delegate',
        purpose: 'execution',
        preferredMode: 'lisa',
        reason: 'implementation request',
      };
    }

    return { kind: 'direct', reason: 'no strong orchestration signal' };
  }

  private formatAutoRouteNotice(decision: AutoRouteDecision): string {
    if (decision.kind === 'team') {
      return `Auto route · team ${decision.strategy ?? 'parallel'} · ${decision.reason}`;
    }

    const modeLabel = decision.preferredMode
      ? BLACKPINK_MODES[decision.preferredMode].label
      : 'Auto';
    const purpose = decision.purpose ?? 'general';
    return `Auto route · ${modeLabel} · ${purpose} · ${decision.reason}`;
  }

  private async maybeHandleJennieAutoRoute(trimmedContent: string): Promise<boolean> {
    if (this.currentMode !== 'jennie') {
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
      await this.executeTeamRun(decision.strategy ?? 'parallel', trimmedContent, {
        routeNote: this.formatAutoRouteNotice(decision),
      });
      return true;
    }

    await this.executeDelegatedRoute(userMessage, decision);
    return true;
  }

  private async executeDelegatedRoute(
    userMessage: NativeMessageState,
    decision: AutoRouteDecision,
  ): Promise<void> {
    const assistantMessage: NativeMessageState = {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };
    const routeNotice = this.formatAutoRouteNotice(decision);
    this.state.messages.push({
      id: randomUUID(),
      role: 'system',
      content: routeNotice,
      timestamp: Date.now(),
    });
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

    try {
      await this.hookRegistry.emit('beforeSend', {
        provider: this.getCurrentProvider(),
        model: this.getCurrentModel(),
        sessionId: this.state.sessionId,
        remoteSessionId: null,
        requestMode: 'full',
        prompt: userMessage.content,
      });

      const runtime = this.createDelegationRuntime();
      const result = await runtime.run(
        {
          prompt: userMessage.content,
          purpose: decision.purpose,
          preferredMode: decision.preferredMode,
          parentSessionId: this.state.sessionId,
          maxTokens: this.config ? getMaxTokens(this.config) : undefined,
          cwd: process.cwd(),
          isolatedLabel: `route-${decision.preferredMode ?? decision.purpose ?? 'general'}`,
          verificationMode: this.verificationModeForPurpose(decision.purpose),
        },
        {
          signal: controller.signal,
          onText: (delta) => {
            if (!delta) {
              return;
            }

            const current = this.state.messages.find((message) => message.id === assistantMessage.id)?.content ?? '';
            this.updateMessage(assistantMessage.id, current + delta);
          },
          onToolState: (states) => {
            this.applyToolStates(assistantMessage.id, states);
          },
        },
      );

      const finalText = result.text.trim() || `[${BLACKPINK_MODES[result.mode].label}] no output`;
      this.finishMessage(assistantMessage.id, finalText);
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
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        await this.hookRegistry.emit('onError', {
          provider: this.getCurrentProvider(),
          model: this.getCurrentModel(),
          sessionId: this.state.sessionId,
          operation: 'delegate',
          message: serializeError(error),
        });
        this.finishMessage(assistantMessage.id, toErrorMessage(error));
      } else {
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

  private classifyToolRisk(name: string, input: Record<string, unknown>): 'read' | 'write' | 'dangerous' {
    if (
      name === 'read_file' ||
      name === 'list_dir' ||
      name === 'grep' ||
      name === 'glob' ||
      name === 'web_fetch' ||
      name === 'repo_map' ||
      name === 'symbol_search' ||
      name === 'reference_search' ||
      name === 'changed_files' ||
      name === 'codebase_search' ||
      name === 'ask_question' ||
      name === 'oracle'
    ) {
      return 'read';
    }

    if (name === 'memory') {
      const action = readString(input.action) || 'read';
      return action === 'read' ? 'read' : 'write';
    }

    if (name === 'write_file' || name === 'edit_file' || name === 'update_plan') {
      return 'write';
    }

    if (name.startsWith('mcp__') || name === 'bash' || name === 'task') {
      return 'dangerous';
    }

    return 'dangerous';
  }

  private async authorizeToolExecution(
    block: ToolUseBlock,
    toolContext: ToolContext,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const input = typeof block.input === 'object' && block.input !== null ? block.input as Record<string, unknown> : {};
    const risk = this.classifyToolRisk(block.name, input);

    if (this.permissionProfile === 'permissionless') {
      return { allowed: true };
    }

    if (this.permissionProfile === 'plan') {
      if (risk === 'read') {
        return { allowed: true };
      }
      return { allowed: false, reason: `Blocked ${block.name}: current permission profile is plan (read-only).` };
    }

    if (this.permissionProfile === 'workspace-write') {
      if (risk !== 'dangerous') {
        return { allowed: true };
      }
    } else if (this.permissionProfile === 'ask' && risk === 'read') {
      return { allowed: true };
    }

    const summary = summarizeToolInput(block.name, input);
    const answer = toolContext.askUser
      ? await toolContext.askUser(
        `Allow ${summary}?`,
        ['Allow once', `Deny (${this.permissionProfile})`],
      )
      : 'Deny';

    return {
      allowed: answer.toLowerCase().includes('allow'),
      reason: `Denied ${block.name}: approval was not granted.`,
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
    const results: ToolResultBlock[] = [];

    for (const block of blocks) {
      const tool = registry.get(block.name);
      if (!tool) {
        this.setToolStatus(context.assistantMessageId, block.id, 'error', `Unknown tool: ${block.name}`);
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Unknown tool: ${block.name}`,
          is_error: true,
        });
        continue;
      }

      let progress = '';
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
          this.setToolStatus(
            context.assistantMessageId,
            block.id,
            'running',
            summarizeToolResult(progress),
          );
        },
      };

      const authorization = await this.authorizeToolExecution(block, toolContext);
      if (!authorization.allowed) {
        const message = authorization.reason ?? `Tool blocked by permission profile ${this.permissionProfile}`;
        this.setToolStatus(context.assistantMessageId, block.id, 'error', summarizeToolResult(message));
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: message,
          is_error: true,
        });
        continue;
      }

      try {
        await this.hookRegistry.emit('beforeToolCall', {
          tool: block.name,
          input: block.input,
          sessionId: this.state.sessionId,
        });
        const result = await tool.execute(block.input, toolContext);
        if (result.metadata && typeof result.metadata === 'object') {
          const metadata = result.metadata as Record<string, unknown>;
          if (typeof metadata.workspacePath === 'string' && metadata.workspacePath.trim()) {
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

        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.output,
          is_error: result.isError || undefined,
        });
      } catch (error: unknown) {
        const message = serializeError(error);
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
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: message,
          is_error: true,
        });
      }
    }

    return results;
  }

  private async refreshSystemPrompt(): Promise<void> {
    const mode = this.currentMode;
    const model = this.getCurrentModel();
    const modeConfig = BLACKPINK_MODES[mode] ?? BLACKPINK_MODES.jennie;
    const cwd = process.cwd();
    const projectName = basename(cwd) || 'unknown-project';
    const loadedSkills = Array.from(this.loadedSkills.values());

    try {
      let prompt = await loadSystemPrompt({
        model,
        provider: modeConfig.provider,
        cwd,
        projectName,
        version: PROMPT_VERSION,
        timestamp: new Date().toISOString(),
        rules: [],
        skills: loadedSkills.map((skill) => skill.name),
        userInstructions: modeConfig.promptAddition.trim(),
      });

      if (loadedSkills.length > 0) {
        prompt += `\n\n${loadedSkills
          .map(
            (skill) =>
              `<skill name="${skill.name}">\n${skill.content.trim()}\n</skill>`,
          )
          .join('\n\n')}`;
      }

      try {
        const memory = await loadMemory(cwd);
        if (hasMeaningfulMemory(memory)) {
          prompt += `\n\n<memory>\n${memory}\n</memory>`;
        }
      } catch {
        // Memory is optional; keep prompt generation resilient.
      }

      const planSummary = this.formatPlanSummary();
      prompt += `\n\n<workflow>\npermission_profile: ${this.permissionProfile}\n${planSummary}\n</workflow>`;

      this.systemPrompt = prompt;
    } catch {
      this.systemPrompt = buildFallbackSystemPrompt(mode, model);
    }

    this.syncUsageState();
  }

  private getWorkflowSnapshot(): WorkflowStateSnapshot {
    return {
      mode: this.currentMode,
      selectedModels: { ...this.selectedModels },
      permissionProfile: this.permissionProfile,
      todos: this.todos.map((item) => ({ ...item })),
      remoteSessions: Array.from(this.remoteSessions.values()).map((session) => ({ ...session })),
    };
  }

  private async persistWorkflowState(
    reason: string,
    sessionId: string = this.state.sessionId ?? '',
    snapshot: WorkflowStateSnapshot = this.getWorkflowSnapshot(),
  ): Promise<void> {
    if (!this.sessionManager || !sessionId) {
      return;
    }

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

  private parseWorkflowSnapshot(entry: SessionEntry): WorkflowStateSnapshot | null {
    const snapshot = entry.data.controllerState;
    if (typeof snapshot !== 'object' || snapshot === null) {
      return null;
    }

    const record = snapshot as Record<string, unknown>;
    const mode =
      record.mode === 'jennie' || record.mode === 'lisa' || record.mode === 'rosé' || record.mode === 'jisoo'
        ? record.mode
        : this.currentMode;
    const permissionProfile = normalizePermissionProfile(record.permissionProfile);
    const selectedModelsRecord = typeof record.selectedModels === 'object' && record.selectedModels !== null
      ? (record.selectedModels as Record<string, unknown>)
      : {};
    const selectedModels: Record<NamedMode, string> = {
      jennie: typeof selectedModelsRecord.jennie === 'string' ? selectedModelsRecord.jennie : this.selectedModels.jennie,
      lisa: typeof selectedModelsRecord.lisa === 'string' ? selectedModelsRecord.lisa : this.selectedModels.lisa,
      'rosé': typeof selectedModelsRecord['rosé'] === 'string' ? selectedModelsRecord['rosé'] : this.selectedModels['rosé'],
      jisoo: typeof selectedModelsRecord.jisoo === 'string' ? selectedModelsRecord.jisoo : this.selectedModels.jisoo,
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

    return {
      mode,
      selectedModels,
      permissionProfile,
      todos,
      remoteSessions,
    };
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
      this.restoreSession(loaded);
      return true;
    } catch (error: unknown) {
      this.appendSystemMessage(
        `[session] Failed to resume ${requestedSessionId}: ${serializeError(error)}`,
      );
      return false;
    }
  }

  private restoreSession(session: LoadedSession): void {
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

      const snapshot = this.parseWorkflowSnapshot(entry);
      if (snapshot) {
        restoredSnapshot = snapshot;
        continue;
      }

      const user = getEntryString(entry, 'user');
      const assistant = getEntryString(entry, 'assistant');
      const system = getEntryString(entry, 'system');
      const mode = getEntryString(entry, 'mode');
      const entryMode =
        mode === 'jennie' || mode === 'lisa' || mode === 'rosé' || mode === 'jisoo'
          ? mode
          : null;

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

    const inferredMode =
      restoredSnapshot?.mode ??
      restoredMode ??
      findModeForProviderModel(session.header.provider, session.header.model) ??
      this.currentMode;

    this.currentMode = inferredMode;
    this.state.mode = inferredMode;
    this.remoteSessions.clear();

    if (restoredSnapshot) {
      this.selectedModels = { ...restoredSnapshot.selectedModels };
      this.permissionProfile = restoredSnapshot.permissionProfile;
      this.lastSafePermissionProfile =
        this.permissionProfile === 'permissionless' ? DEFAULT_PERMISSION_PROFILE : this.permissionProfile;
      this.state.permissionProfile = this.permissionProfile;
      this.state.playingWithFire = this.permissionProfile === 'permissionless';
      this.todos = restoredSnapshot.todos.map((item) => ({ ...item }));
      this.state.todos = this.todos.map((item) => ({ ...item }));
      for (const remoteSession of restoredSnapshot.remoteSessions) {
        this.remoteSessions.set(remoteSession.provider, { ...remoteSession });
      }
    }

    if (session.header.model && !restoredSnapshot) {
      this.selectedModels[inferredMode] = session.header.model;
    }

    this.state.sessionId = session.header.id;
    this.state.messages = restoredMessages;
    this.updateRemoteSessionState();
  }

  private async initializeMcpTools(): Promise<void> {
    if (!this.config || !this.toolRegistry) {
      return;
    }

    const entries = Object.entries(this.config.mcp.servers ?? {});
    if (entries.length === 0) {
      return;
    }

    const manager = new McpManager();
    for (const [name, config] of entries) {
      manager.addServer(name, config as McpServerConfig);
    }

    await manager.connectAll();
    for (const tool of manager.getAllTools()) {
      this.toolRegistry.register(buildMcpTool(manager, tool));
    }

    this.mcpManager = manager;
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

  private getCurrentProvider(): string {
    const mode = BLACKPINK_MODES[this.currentMode] ?? BLACKPINK_MODES.jennie;
    return mode.provider;
  }

  private getCurrentModel(): string {
    return this.selectedModels[this.currentMode] ?? BLACKPINK_MODES[this.currentMode].model;
  }

  private resolveCurrentProviderModels(): string[] {
    if (!this.config) {
      return [];
    }

    const providerName = resolveProviderConfigName(this.getCurrentProvider());
    const providerConfig = this.config.providers[providerName];
    return providerConfig?.models.map((model) => model.id) ?? [];
  }

  private reconfigureClient(): void {
    const provider = this.getCurrentProvider();
    const model = this.getCurrentModel();
    const modeConfig = BLACKPINK_MODES[this.currentMode] ?? BLACKPINK_MODES.jennie;

    this.state.provider = provider;
    this.state.model = model;
    this.state.models = this.resolveCurrentProviderModels();
    this.state.modes = MODE_ORDER.map((modeName) => {
      const modeEntry = BLACKPINK_MODES[modeName];
      return {
        name: modeName,
        label: modeEntry.label,
        tagline: modeEntry.tagline,
        provider: modeEntry.provider,
        model: this.selectedModels[modeName] ?? modeEntry.model,
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

    this.systemPrompt = buildFallbackSystemPrompt(this.currentMode, model)
      .replace(/\$\{provider\}/g, modeConfig.provider);

    this.updateRemoteSessionState();
    this.syncUsageState();
  }

  private estimateCurrentContextFootprint(): { tokens: number; limit: number; percent: number } {
    const provider = this.getCurrentProvider();
    const history = countApiMessageTokens(
      toApiMessages(this.getCanonicalConversationMessages()),
      (text) => this.tokenCounter.countTokens(text),
    );
    const includeTools = !this.isBridgeBackedProvider(provider);
    const includeSystem = provider === 'anthropic' || !this.isBridgeBackedProvider(provider);
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
      bridgeBacked: this.isBridgeBackedProvider(provider),
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
      resolveModel: (mode: NamedMode): string => {
        return this.selectedModels[mode] ?? BLACKPINK_MODES[mode].model;
      },
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
    const includeTools = !this.isBridgeBackedProvider(provider);
    const includeSystem =
      plan.mode === 'full' ||
      provider === 'anthropic' ||
      !this.isBridgeBackedProvider(provider);

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
    const modeEntry = BLACKPINK_MODES[this.currentMode] ?? BLACKPINK_MODES.jennie;
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
    const estimate =
      this.state.requestEstimate ??
      createRequestEstimate({
        system: this.tokenCounter.countTokens(this.systemPrompt),
        history: 0,
        tools: this.isBridgeBackedProvider()
          ? 0
          : this.toolRegistry
          ? this.tokenCounter.countTokens(JSON.stringify(formatToolsForApi(this.toolRegistry)))
          : 0,
        prompt: 0,
        mode: 'full',
      });
    const queue = this.queuedPrompts.length > 0 ? this.queuedPrompts.length.toString() : '0';

    return [
      'Doctor',
      `provider: ${this.state.provider}`,
      `model: ${this.state.model}`,
      `auth: ${this.state.authType ?? 'missing'}${this.state.authSource ? ` via ${this.state.authSource}` : ''}`,
      `context: ${this.state.contextTokens.toLocaleString()} / ${this.state.contextLimit.toLocaleString()} (${(this.state.contextPercent * 100).toFixed(1)}%)`,
      `working set: ${profile.canonicalWorkingSetTokens.toLocaleString()} · auto compact at ${profile.autoCompactAtTokens.toLocaleString()}`,
      `next ${estimate.mode}: system ${estimate.system.toLocaleString()} + history ${estimate.history.toLocaleString()} + tools ${estimate.tools.toLocaleString()} + prompt ${estimate.prompt.toLocaleString()} = ~${estimate.total.toLocaleString()}`,
      ...(estimate.note ? [`note: ${estimate.note}`] : []),
      `permissions: ${this.permissionProfile}`,
      `plan items: ${this.todos.length}`,
      `skills loaded: ${this.loadedSkills.size}`,
      `remote bridge sessions: ${this.remoteSessions.size}`,
      `background queue: ${queue}`,
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

  private async runPermissionsCommand(args: string[]): Promise<string> {
    const requested = args[0]?.trim().toLowerCase();
    if (!requested) {
      return `Permissions\ncurrent: ${this.permissionProfile}\nprofiles: plan, ask, workspace-write, permissionless`;
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
    if (entries.length === 0) {
      return 'No MCP servers configured.';
    }

    const connected = new Set(this.mcpManager?.getConnectedServers() ?? []);
    const toolCount = this.toolRegistry
      ?.list()
      .filter((tool) => tool.name.startsWith('mcp__')).length ?? 0;

    return [
      'MCP servers',
      `connected: ${connected.size}/${entries.length}`,
      `tools: ${toolCount}`,
      ...entries.map(([name, config]) => {
        const status = connected.has(name) ? 'connected' : 'disconnected';
        return `${name} · ${config.command} · ${status}`;
      }),
    ].join('\n');
  }

  private formatHookSummary(): string {
    const stats = this.hookRegistry.stats();
    const lines = Object.entries(stats).map(([event, count]) => `${event} · ${count}`);
    return ['Hooks', ...lines].join('\n');
  }

  private formatTeamSummary(): string {
    const availableModes = this.getTeamEligibleModes();
    return [
      'Team',
      `orchestrator: ${availableModes.length > 0 ? 'ready' : 'unavailable'}`,
      'strategies: parallel, sequential, delegate',
      `available modes: ${availableModes.map((mode) => BLACKPINK_MODES[mode].label).join(', ') || 'none'}`,
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

    if (this.state.loading || this.abortController) {
      return 'Team run unavailable while another request is active.';
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

    const teamAgents = this.buildTeamAgents();
    if (teamAgents.length < 2) {
      return 'Team run unavailable: need at least one lead and one worker with valid auth.';
    }

    const assistantMessageId = randomUUID();
    const notice = options.routeNote
      ? `${options.routeNote} · ${previewText(task, 96)}`
      : `Team run started · ${strategy} · ${previewText(task, 96)}`;
    this.state.messages.push({
      id: randomUUID(),
      role: 'system',
      content: notice,
      timestamp: Date.now(),
    });
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
    this.teamRunIsolatedNotes.length = 0;
    this.scheduleStatePush();

    const controller = new AbortController();
    this.abortController = controller;

    try {
      const orchestrator = new TeamOrchestrator({
        name: 'ddudu-native-team',
        agents: teamAgents,
        strategy,
        maxRounds: 2,
        sharedContext: `cwd=${process.cwd()} · mode=${this.currentMode} · model=${this.getCurrentModel()}`,
        runAgent: async (agent, input, round) => this.executeTeamAgent(agent, input, round, controller.signal),
        onMessage: (message) => {
          this.updateMessage(
            assistantMessageId,
            this.formatTeamProgress(message),
          );
        },
      });

      const result = await orchestrator.run(task, controller.signal);
      const formatted = this.formatTeamResult(strategy, task, teamAgents, result.messages, result.output, result.success, result.rounds);
      this.teamLastSummary = `${strategy} · ${result.success ? 'ok' : 'incomplete'} · ${result.rounds} rounds`;
      this.finishMessage(assistantMessageId, formatted);
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
      this.scheduleStatePush();
    }
  }

  private buildTeamAgents(): TeamAgentRole[] {
    const availableModes = this.getTeamEligibleModes();
    if (availableModes.length === 0) {
      return [];
    }

    const leadMode = availableModes.includes('jennie') ? 'jennie' : availableModes[0];
    const workerModes = availableModes.filter((mode) => mode !== leadMode);
    const primaryWorkerMode = workerModes[0] ?? leadMode;
    const secondaryWorkerMode = workerModes[1] ?? null;
    const reviewerMode = workerModes[2] ?? secondaryWorkerMode ?? primaryWorkerMode ?? leadMode;

    const makeAgent = (
      id: string,
      mode: NamedMode,
      role: 'lead' | 'worker' | 'reviewer',
      systemPrompt: string,
    ): TeamAgentRole => {
      const modeConfig = BLACKPINK_MODES[mode] ?? BLACKPINK_MODES.jennie;
      return {
        id,
        name: modeConfig.label,
        mode,
        role,
        provider: modeConfig.provider,
        model: this.selectedModels[mode] ?? modeConfig.model,
        systemPrompt,
      };
    };

    const agents: TeamAgentRole[] = [
      makeAgent(
        'lead',
        leadMode,
        'lead',
        'Coordinate a coding team. Break the task down, synthesize worker outputs, and return the best merged answer.',
      ),
      makeAgent(
        'worker_fast',
        primaryWorkerMode,
        'worker',
        'Execute one focused subtask. Be concrete, direct, and implementation-oriented.',
      ),
    ];

    if (secondaryWorkerMode) {
      agents.push(
        makeAgent(
          'worker_deep',
          secondaryWorkerMode,
          'worker',
          'Analyze edge cases and architecture risks for the assigned subtask before answering.',
        ),
      );
    }

    if (reviewerMode) {
      agents.push(
        makeAgent(
          'reviewer',
          reviewerMode,
          'reviewer',
          'Review the combined team output, point out risks, and suggest corrections if needed.',
        ),
      );
    }

    return agents;
  }

  private async executeTeamAgent(
    agent: TeamAgentRole,
    input: string,
    round: number,
    signal: AbortSignal,
  ): Promise<string> {
    const runtime = this.createDelegationRuntime();
    const purpose: DelegationPurpose =
      agent.role === 'lead' ? 'review' : agent.role === 'reviewer' ? 'review' : 'execution';
    const result = await runtime.run(
      {
        prompt: [
          `Round ${round}`,
          `Team task context for ${agent.name}:`,
          input,
        ].join('\n\n'),
        purpose,
        preferredMode: agent.mode,
        preferredModel: agent.model,
        systemPrompt: agent.systemPrompt,
        maxTokens: this.config ? getMaxTokens(this.config) : undefined,
        parentSessionId: this.state.sessionId,
        cwd: process.cwd(),
        isolatedLabel: `team-${agent.id}-r${round}`,
        verificationMode: agent.role === 'worker' || agent.role === 'reviewer' ? 'checks' : 'none',
      },
      { signal },
    );

    this.setWorkspaceState(result.workspace ?? null);
    if (result.verification) {
      this.setVerificationState({
        status: result.verification.status,
        summary: result.verification.summary,
        cwd: result.verification.cwd,
      });
    }
    if (result.workspace || result.verification) {
      this.teamRunIsolatedNotes.push(
        [
          `- ${agent.name}`,
          result.workspace ? `workspace ${result.workspace.path}` : null,
          result.verification ? `verify ${result.verification.summary}` : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join(' · '),
      );
    }

    return result.text.trim() || `[${agent.name}] no output`;
  }

  private formatTeamProgress(message: TeamMessage): string {
    const meta = message.metadata && Object.keys(message.metadata).length > 0
      ? ` ${JSON.stringify(message.metadata)}`
      : '';
    return [
      `team · ${message.type}`,
      `${message.from} → ${message.to}${meta}`,
      '',
      previewText(message.content, 320),
    ].join('\n');
  }

  private formatTeamResult(
    strategy: 'parallel' | 'sequential' | 'delegate',
    task: string,
    agents: TeamAgentRole[],
    messages: TeamMessage[],
    output: string,
    success: boolean,
    rounds: number,
  ): string {
    const recentMessages = messages
      .slice(-6)
      .map((message) => `- ${message.from} -> ${message.to} [${message.type}] ${previewText(message.content, 92)}`);

    return [
      '# Team Run',
      '',
      `status: ${success ? 'success' : 'incomplete'}`,
      `strategy: ${strategy}`,
      `rounds: ${rounds}`,
      `task: ${task}`,
      `agents: ${agents.map((agent) => `${agent.name}/${agent.model}`).join(', ')}`,
      '',
      '## Final Output',
      output.trim() || 'No final output.',
      '',
      '## Recent Coordination',
      ...(recentMessages.length > 0 ? recentMessages : ['- No coordination messages recorded.']),
      ...(this.teamRunIsolatedNotes.length > 0
        ? ['', '## Isolated Runs', ...this.teamRunIsolatedNotes]
        : []),
    ].join('\n');
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

  private isBridgeBackedProvider(provider: string = this.getCurrentProvider()): boolean {
    const auth = this.availableProviders.get(provider);
    if (provider === 'anthropic') {
      return auth?.tokenType === 'oauth';
    }

    if (provider === 'openai') {
      return auth?.tokenType === 'bearer';
    }

    return false;
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

  private rememberRemoteSession(session: BridgeSessionState): void {
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
    const bridgeSession = !forceFresh ? this.remoteSessions.get(provider) : undefined;
    const canonicalMessages = this.getCanonicalConversationMessages();

    if (this.isBridgeBackedProvider(provider) && bridgeSession) {
      const missingMessages = canonicalMessages.slice(bridgeSession.syncedMessageCount);
      if (missingMessages.length === 0) {
        return {
          apiMessages: [{ role: 'user', content: userMessage.content }],
          mode: 'resume',
          note: `bridge resume · ${provider} session ${bridgeSession.sessionId.slice(0, 8)}`,
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
        note: `bridge hydrate · ${missingMessages.length} canonical messages since last ${provider} turn`,
        remoteSessionId: bridgeSession.sessionId,
      };
    }

    return {
      apiMessages: toApiMessages([...this.state.messages, userMessage]),
      mode: 'full',
      note: this.isBridgeBackedProvider(provider)
        ? 'fresh bridge session · provider CLI adds its own hidden scaffold'
        : null,
      remoteSessionId: null,
    };
  }

  private async buildHydrationPrompt(
    missingMessages: NativeMessageState[],
    remoteSession: BridgeSessionState,
    nextPrompt: string,
  ): Promise<string> {
    const profile = this.getContextProfile(remoteSession.provider, remoteSession.lastModel);
    const compactionMessages = buildCompactionMessages(
      missingMessages,
      this.getCompactionBuildOptions(remoteSession.provider),
    );
    const delta =
      missingMessages.length <= profile.hydrateInlineMessages
        ? compactionMessages.map((message) => `[${message.role}] ${message.content}`).join('\n')
        : await this.compactionEngine.compact(compactionMessages, 'Sync this provider session to ddudu canonical context.');

    return [
      'ddudu canonical session has advanced while you were inactive.',
      `Resume the existing provider session and treat the following delta as authoritative context since session ${remoteSession.sessionId.slice(0, 8)}:`,
      '',
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

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.emit({
      type: 'state',
      state: {
        ...this.state,
        requestEstimate: this.state.requestEstimate ? { ...this.state.requestEstimate } : null,
        queuedPrompts: [...this.state.queuedPrompts],
        messages: this.state.messages.map((message) => ({
          ...message,
          toolCalls: message.toolCalls ? [...message.toolCalls] : undefined,
        })),
        providers: this.state.providers.map((provider) => ({ ...provider })),
        modes: this.state.modes.map((mode) => ({ ...mode })),
        slashCommands: this.state.slashCommands.map((command) => ({ ...command })),
        todos: this.state.todos.map((item) => ({ ...item })),
        askUser: this.state.askUser ? { ...this.state.askUser, options: [...this.state.askUser.options] } : null,
      },
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
