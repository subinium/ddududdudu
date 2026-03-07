import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import { DEFAULT_ANTHROPIC_BASE_URL } from '../../api/anthropic-base-url.js';
import type { ApiMessage, ContentBlock, ToolUseContentBlock } from '../../api/anthropic-client.js';
import { createClient, type ApiClient, type StreamEvent } from '../../api/client-factory.js';
import type { ToolResultBlock, ToolUseBlock } from '../../api/tool-executor.js';
import { formatToolsForApi } from '../../api/tool-executor.js';
import { discoverAllProviders, type ProviderAuth } from '../../auth/discovery.js';
import { loadConfig } from '../../core/config.js';
import { CompactionEngine } from '../../core/compaction.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../core/default-prompts.js';
import { HookRegistry } from '../../core/hooks.js';
import { initializeProject } from '../../core/project-init.js';
import { loadMemory } from '../../core/memory.js';
import { SessionManager } from '../../core/session.js';
import { SkillLoader } from '../../core/skill-loader.js';
import { TokenCounter } from '../../core/token-counter.js';
import type { DduduConfig, NamedMode } from '../../core/types.js';
import type { ToolContext } from '../../tools/index.js';
import { ToolRegistry } from '../../tools/registry.js';
import { discoverToolboxTools } from '../../tools/toolbox.js';
import { BLACKPINK_MODES, BP_LYRICS, MODE_ORDER } from '../ink/theme.js';
import { SLASH_COMMANDS } from '../ink/types.js';
import {
  buildCompactionMessages,
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

type EmitFn = (event: NativeBridgeEvent) => void;
type AskUserResolver = {
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
};

const MAX_TOOL_TURNS_FALLBACK = 25;
const PROVIDER_NAMES = ['anthropic', 'openai', 'gemini'] as const;

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

const buildSystemPrompt = (mode: NamedMode): string => {
  const modeConfig = BLACKPINK_MODES[mode] ?? BLACKPINK_MODES.jennie;
  const cwd = process.cwd();
  const projectName = basename(cwd) || 'unknown-project';

  return DEFAULT_SYSTEM_PROMPT
    .replace(/\$\{model\}/g, modeConfig.model)
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
  return previewText(result, 88);
};

export class NativeBridgeController {
  private readonly emit: EmitFn;
  private config: DduduConfig | null = null;
  private readonly state: NativeTuiState = {
    ready: false,
    cwd: process.cwd(),
    mode: 'jennie',
    modes: [],
    provider: 'anthropic',
    model: BLACKPINK_MODES.jennie.model,
    models: [],
    authType: null,
    authSource: null,
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
  private tokenCounter = new TokenCounter(BLACKPINK_MODES.jennie.model);
  private systemPrompt = buildSystemPrompt('jennie');
  private abortController: AbortController | null = null;
  private activeAssistantMessageId: string | null = null;
  private queuedPrompts: string[] = [];
  private pendingAskUser: AskUserResolver | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly compactionEngine = new CompactionEngine();
  private readonly hookRegistry = new HookRegistry();
  private readonly remoteSessions = new Map<string, BridgeSessionState>();

  public constructor(emit: EmitFn) {
    this.emit = emit;
  }

  public async boot(): Promise<void> {
    this.config = await loadConfig();
    this.currentMode = clampMode(this.config.mode);
    this.state.mode = this.currentMode;
    this.state.playingWithFire = this.config.tools.permission === 'auto';
    this.systemPrompt = buildSystemPrompt(this.currentMode);

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

    this.sessionManager = new SessionManager(this.config.session.directory);
    try {
      const session = await this.sessionManager.create({
        provider: this.getCurrentProvider(),
        model: this.getCurrentModel(),
      });
      this.state.sessionId = session.id;
      await this.hookRegistry.emit('onSessionStart', {
        sessionId: session.id,
        provider: this.getCurrentProvider(),
        model: this.getCurrentModel(),
      });
    } catch (error: unknown) {
      this.appendSystemMessage(`[session] ${serializeError(error)}`);
    }

    this.reconfigureClient();
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
          'Available commands: /clear, /compact, /mode, /model, /memory, /session, /config, /help, /doctor, /quit, /fire, /init, /skill, /hook, /mcp, /team',
        );
        return;
      case '/config':
        this.appendSystemMessage(this.formatConfigSummary());
        return;
      case '/doctor':
        this.appendSystemMessage(this.formatDoctorSummary());
        return;
      case '/session':
        this.appendSystemMessage(await this.formatSessionSummary());
        return;
      case '/memory':
        this.appendSystemMessage(await this.formatMemorySummary());
        return;
      case '/skill':
        this.appendSystemMessage(await this.formatSkillSummary());
        return;
      case '/mcp':
        this.appendSystemMessage(this.formatMcpSummary());
        return;
      case '/hook':
        this.appendSystemMessage(this.formatHookSummary());
        return;
      case '/team':
        this.appendSystemMessage(this.formatTeamSummary());
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
    this.systemPrompt = buildSystemPrompt(this.currentMode);
    this.reconfigureClient();
    void this.hookRegistry.emit('onModeSwitch', {
      from: previousMode,
      to: this.currentMode,
      provider: this.getCurrentProvider(),
      model: this.getCurrentModel(),
    });
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
    this.scheduleStatePush();
  }

  public toggleFire(): void {
    this.state.playingWithFire = !this.state.playingWithFire;
    this.scheduleStatePush();
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

    if (this.isBridgeBackedProvider()) {
      this.invalidateRemoteSession(this.getCurrentProvider());
    }

    this.state.loading = false;
    this.state.loadingLabel = '';
    this.state.loadingSince = null;
    this.state.requestEstimate = null;
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
    this.tokenCounter.setModel(model);

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

    return Promise.all(
      blocks.map(async (block): Promise<ToolResultBlock> => {
        const tool = registry.get(block.name);
        if (!tool) {
          this.setToolStatus(context.assistantMessageId, block.id, 'error', `Unknown tool: ${block.name}`);
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Unknown tool: ${block.name}`,
            is_error: true,
          };
        }

        let progress = '';
        const toolContext: ToolContext = {
          cwd: process.cwd(),
          abortSignal: context.signal,
          authToken: anthropicAuth?.token,
          authBaseUrl: process.env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL,
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

        try {
          await this.hookRegistry.emit('beforeToolCall', {
            tool: block.name,
            input: block.input,
            sessionId: this.state.sessionId,
          });
          const result = await tool.execute(block.input, toolContext);
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

          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.output,
            is_error: result.isError || undefined,
          };
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
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: message,
            is_error: true,
          };
        }
      }),
    );
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

    if (providerAuth) {
      this.activeClient = createClient(provider, providerAuth.token, providerAuth.tokenType);
      this.state.error = null;
    } else {
      this.activeClient = null;
      this.state.error = `No auth found for ${provider}. Run: ddudu auth login`;
    }

    this.systemPrompt = buildSystemPrompt(this.currentMode)
      .replace(/\$\{model\}/g, model)
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
      `fire mode: ${this.state.playingWithFire ? 'on' : 'off'}`,
      `session: ${this.state.sessionId ?? 'none'}`,
      `tools: ${this.toolRegistry?.list().length ?? 0}`,
    ].join('\n');
  }

  private formatDoctorSummary(): string {
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
      `next ${estimate.mode}: system ${estimate.system.toLocaleString()} + history ${estimate.history.toLocaleString()} + tools ${estimate.tools.toLocaleString()} + prompt ${estimate.prompt.toLocaleString()} = ~${estimate.total.toLocaleString()}`,
      ...(estimate.note ? [`note: ${estimate.note}`] : []),
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

      return ['Skills', ...skills.slice(0, 12).map((skill) => `${skill.name} · ${skill.description}`)].join('\n');
    } catch (error: unknown) {
      return `Skill scan failed: ${serializeError(error)}`;
    }
  }

  private formatMcpSummary(): string {
    const entries = Object.entries(this.config?.mcp.servers ?? {});
    if (entries.length === 0) {
      return 'No MCP servers configured.';
    }

    return ['MCP servers', ...entries.map(([name, config]) => `${name} · ${config.command}`)].join('\n');
  }

  private formatHookSummary(): string {
    const stats = this.hookRegistry.stats();
    const lines = Object.entries(stats).map(([event, count]) => `${event} · ${count}`);
    return ['Hooks', ...lines].join('\n');
  }

  private formatTeamSummary(): string {
    const toolNames = this.toolRegistry?.list().map((tool) => tool.name) ?? [];
    const hasTaskTool = toolNames.includes('task');
    return [
      'Team',
      `task tool: ${hasTaskTool ? 'available' : 'missing'}`,
      'core orchestrator: available',
      'strategies: parallel, sequential, delegate',
      'native TUI team runs: use the task tool from the active session',
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

  private async compactContext(): Promise<void> {
    const messages = buildCompactionMessages(this.state.messages);
    if (messages.length === 0) {
      this.appendSystemMessage('Nothing to compact.');
      return;
    }

    try {
      const compacted = await this.compactionEngine.compact(messages);
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
    this.scheduleStatePush();
  }

  private invalidateRemoteSession(provider: string): void {
    this.remoteSessions.delete(provider);
    this.updateRemoteSessionState();
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
    const compactionMessages = buildCompactionMessages(missingMessages);
    const delta =
      missingMessages.length <= 4
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
