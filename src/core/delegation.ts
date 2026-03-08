import type { ApiMessage, ToolStateUpdate } from '../api/anthropic-client.js';
import { createClient } from '../api/client-factory.js';
import { SessionManager } from './session.js';
import type { NamedMode, SessionEntry } from './types.js';
import type { VerificationMode, VerificationSummary } from './verifier.js';
import { VerificationRunner } from './verifier.js';
import type { IsolatedWorkspace, WorkspaceApplyResult } from './worktree-manager.js';
import { WorktreeManager } from './worktree-manager.js';
import type { WorkflowArtifact } from './workflow-state.js';

export interface DelegationCredentials {
  token: string;
  tokenType: string;
  source: string;
}

export type DelegationPurpose =
  | 'general'
  | 'execution'
  | 'planning'
  | 'research'
  | 'review'
  | 'design'
  | 'oracle';

export interface DelegationRequest {
  prompt: string;
  purpose?: DelegationPurpose;
  preferredMode?: NamedMode;
  preferredModel?: string;
  systemPrompt?: string;
  maxTokens?: number;
  parentSessionId?: string | null;
  cwd?: string;
  isolatedLabel?: string;
  verificationMode?: VerificationMode;
  forceIsolation?: boolean;
  applyWorkspaceChanges?: boolean;
  contextSnapshot?: string;
  artifacts?: WorkflowArtifact[];
}

export interface DelegationHandlers {
  onText?: (text: string) => void;
  onToolState?: (states: ToolStateUpdate[]) => void;
  onVerificationState?: (state: { status: 'running' | 'passed' | 'failed' | 'skipped'; summary?: string }) => void;
  signal?: AbortSignal;
}

export interface DelegationResult {
  text: string;
  mode: NamedMode;
  provider: string;
  model: string;
  purpose: DelegationPurpose;
  localSessionId?: string;
  remoteSessionId?: string;
  cwd: string;
  workspace?: IsolatedWorkspace | null;
  workspaceApply?: WorkspaceApplyResult | null;
  verification?: VerificationSummary;
  usage: {
    input: number;
    output: number;
    uncachedInput?: number;
    cachedInput?: number;
    cacheWriteInput?: number;
  };
  durationMs: number;
}

interface DelegationModeProfile {
  mode: NamedMode;
  provider: 'anthropic' | 'openai' | 'gemini';
  defaultModel: string;
  systemPrompt: string;
}

interface DelegationRuntimeConfig {
  cwd: string;
  availableProviders: Map<string, DelegationCredentials>;
  sessionManager?: SessionManager | null;
  resolveModel?: (mode: NamedMode) => string;
  worktreeManager?: WorktreeManager | null;
}

const MODE_PROFILES: Record<NamedMode, DelegationModeProfile> = {
  jennie: {
    mode: 'jennie',
    provider: 'anthropic',
    defaultModel: 'claude-opus-4-6',
    systemPrompt:
      'You are JENNIE inside ddudu. Coordinate, verify, and synthesize. Return crisp decisions and merged conclusions.',
  },
  lisa: {
    mode: 'lisa',
    provider: 'openai',
    defaultModel: 'gpt-5.4',
    systemPrompt:
      'You are LISA inside ddudu. Execute quickly, minimize deliberation, and return direct implementation-ready results.',
  },
  'rosé': {
    mode: 'rosé',
    provider: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    systemPrompt:
      'You are ROSÉ inside ddudu. Plan carefully, reason about architecture, and call out tradeoffs and failure modes.',
  },
  jisoo: {
    mode: 'jisoo',
    provider: 'gemini',
    defaultModel: 'gemini-2.5-pro',
    systemPrompt:
      'You are JISOO inside ddudu. Focus on UX, interface quality, visual direction, and accessibility.',
  },
};

const PURPOSE_FALLBACKS: Record<DelegationPurpose, NamedMode[]> = {
  general: ['lisa', 'jennie', 'rosé', 'jisoo'],
  execution: ['lisa', 'jennie', 'rosé'],
  planning: ['rosé', 'jennie', 'lisa'],
  research: ['rosé', 'jennie', 'lisa'],
  review: ['jennie', 'rosé', 'lisa'],
  design: ['jisoo', 'rosé', 'jennie'],
  oracle: ['jennie', 'rosé', 'lisa'],
};

const normalizeProviderMap = (
  providers: Map<string, DelegationCredentials>,
): Map<string, DelegationCredentials> => {
  const normalized = new Map(providers);
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

const inferPurposeFromPrompt = (prompt: string): DelegationPurpose => {
  const lower = prompt.toLowerCase();
  if (
    /\b(ui|ux|design|layout|spacing|typography|visual|a11y|accessibility|color)\b/.test(lower)
  ) {
    return 'design';
  }

  if (/\b(plan|architecture|strategy|design doc|tradeoff|edge case)\b/.test(lower)) {
    return 'planning';
  }

  if (/\b(review|audit|verify|check|regression|risk)\b/.test(lower)) {
    return 'review';
  }

  if (/\b(research|investigate|explore|find|look into)\b/.test(lower)) {
    return 'research';
  }

  if (/\b(oracle|second opinion|stronger model)\b/.test(lower)) {
    return 'oracle';
  }

  return 'execution';
};

const serializeError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return String(error);
};

const buildSessionEntry = (
  request: DelegationRequest,
  result: DelegationResult,
): SessionEntry => {
  return {
    type: 'message',
    timestamp: new Date().toISOString(),
    data: {
      user: request.prompt,
      assistant: result.text,
      mode: result.mode,
      provider: result.provider,
      model: result.model,
      purpose: result.purpose,
      remoteSessionId: result.remoteSessionId,
      cwd: result.cwd,
      workspacePath: result.workspace?.path,
      workspaceKind: result.workspace?.kind,
      workspaceApply: result.workspaceApply
        ? {
            attempted: result.workspaceApply.attempted,
            applied: result.workspaceApply.applied,
            empty: result.workspaceApply.empty,
            summary: result.workspaceApply.summary,
            error: result.workspaceApply.error,
          }
        : undefined,
      verification: result.verification
        ? {
            status: result.verification.status,
            summary: result.verification.summary,
            cwd: result.verification.cwd,
          }
        : undefined,
      durationMs: result.durationMs,
      usage: result.usage,
    },
  };
};

const previewArtifactText = (value: string, maxLength: number = 320): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const buildDelegationPrompt = (
  request: DelegationRequest,
  purpose: DelegationPurpose,
): string => {
  const sections: string[] = [`Task purpose: ${purpose}`];

  if (request.artifacts && request.artifacts.length > 0) {
    sections.push(
      '<handoff_artifacts>',
      ...request.artifacts.map((artifact) => {
        const attrs = [
          `kind="${artifact.kind}"`,
          `title="${artifact.title.replace(/"/g, '\'')}"`,
          `source="${artifact.source}"`,
          artifact.mode ? `mode="${artifact.mode}"` : null,
        ]
          .filter((part): part is string => Boolean(part))
          .join(' ');
        return `<artifact ${attrs}>\n${previewArtifactText(artifact.summary)}\n</artifact>`;
      }),
      '</handoff_artifacts>',
    );
  }

  sections.push('<task>', request.prompt.trim(), '</task>');
  return sections.join('\n\n');
};

export class DelegationRuntime {
  private readonly config: DelegationRuntimeConfig;
  private readonly providers: Map<string, DelegationCredentials>;

  public constructor(config: DelegationRuntimeConfig) {
    this.config = config;
    this.providers = normalizeProviderMap(config.availableProviders);
  }

  public listAvailableModes(): NamedMode[] {
    return (Object.keys(MODE_PROFILES) as NamedMode[]).filter((mode) => {
      const provider = MODE_PROFILES[mode].provider;
      const auth = this.providers.get(provider);
      return Boolean(auth && !auth.source.includes(':stale'));
    });
  }

  public async run(
    request: DelegationRequest,
    handlers: DelegationHandlers = {},
  ): Promise<DelegationResult> {
    const purpose = request.purpose ?? inferPurposeFromPrompt(request.prompt);
    const mode = this.resolveMode(request.preferredMode, purpose);
    const profile = MODE_PROFILES[mode];
    const provider = profile.provider;
    const auth = this.providers.get(provider);

    if (!auth) {
      throw new Error(`No auth available for delegated mode ${mode} (${provider}).`);
    }

    const model = request.preferredModel ?? this.config.resolveModel?.(mode) ?? profile.defaultModel;
    const baseCwd = request.cwd ?? this.config.cwd;
    const workspace = await this.maybeCreateWorkspace({
      auth,
      provider,
      purpose,
      baseCwd,
      label:
        request.isolatedLabel ??
        [mode, purpose, request.parentSessionId?.slice(0, 8)].filter(Boolean).join('-'),
      forceIsolation: request.forceIsolation ?? false,
    });
    const effectiveCwd = workspace?.path ?? baseCwd;
    const client = createClient(provider, auth.token, auth.tokenType);
    const start = Date.now();
    let text = '';
    let usage = { input: 0, output: 0 } as DelegationResult['usage'];
    let remoteSessionId: string | undefined;
    let localSessionId: string | undefined;
    let verification: VerificationSummary | undefined;
    let workspaceApply: WorkspaceApplyResult | null = null;

    if (this.config.sessionManager) {
      const session = await this.config.sessionManager.create({
        parentId: request.parentSessionId ?? undefined,
        provider,
        model,
        title: `${mode}:${purpose}`,
        metadata: {
          delegated: true,
          mode,
          purpose,
          workspacePath: workspace?.path,
          workspaceKind: workspace?.kind,
        },
      });
      localSessionId = session.id;
    }

    try {
      const messages: ApiMessage[] = [{ role: 'user', content: buildDelegationPrompt(request, purpose) }];
      const combinedSystemPrompt = [request.systemPrompt ?? profile.systemPrompt, request.contextSnapshot]
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n');
      for await (const event of client.stream(messages, {
        systemPrompt: combinedSystemPrompt,
        model,
        maxTokens: request.maxTokens ?? 8192,
        signal: handlers.signal,
        cwd: effectiveCwd,
      })) {
        if (event.type === 'text') {
          const delta = event.text ?? '';
          text += delta;
          handlers.onText?.(delta);
          continue;
        }

        if (event.type === 'tool_state' && event.toolStates) {
          handlers.onToolState?.(event.toolStates);
          continue;
        }

        if (event.type === 'session' && event.sessionId) {
          remoteSessionId = event.sessionId;
          continue;
        }

        if (event.type === 'done') {
          text = event.fullText ?? text;
          usage = event.usage ?? usage;
          break;
        }

        if (event.type === 'error') {
          throw event.error ?? new Error(`Delegated ${mode} request failed.`);
        }
      }

      const verificationMode = this.resolveVerificationMode(purpose, request.verificationMode);
      if (verificationMode !== 'none') {
        handlers.onVerificationState?.({ status: 'running', summary: `verification ${verificationMode}` });
        verification = await new VerificationRunner(effectiveCwd).run(verificationMode);
        handlers.onVerificationState?.({
          status: verification.status,
          summary: verification.summary,
        });
      }

      if (
        request.applyWorkspaceChanges &&
        workspace &&
        (verification === undefined || verification.status === 'passed' || verification.status === 'skipped')
      ) {
        workspaceApply = await this.config.worktreeManager?.applyToBase(workspace) ?? null;
      }

      const result: DelegationResult = {
        text: text.trim(),
        mode,
        provider,
        model,
        purpose,
        localSessionId,
        remoteSessionId,
        cwd: effectiveCwd,
        workspace,
        workspaceApply,
        verification,
        usage,
        durationMs: Date.now() - start,
      };

      if (this.config.sessionManager && localSessionId) {
        await this.config.sessionManager.append(localSessionId, buildSessionEntry(request, result));
      }

      return result;
    } catch (error: unknown) {
      if (this.config.sessionManager && localSessionId) {
        await this.config.sessionManager.append(localSessionId, {
          type: 'message',
          timestamp: new Date().toISOString(),
          data: {
            user: request.prompt,
            assistant: serializeError(error),
            mode,
            provider,
            model,
            purpose,
            isError: true,
          },
        });
      }

      throw error;
    }
  }

  private resolveMode(preferredMode: NamedMode | undefined, purpose: DelegationPurpose): NamedMode {
    const available = this.listAvailableModes();
    if (preferredMode && available.includes(preferredMode)) {
      return preferredMode;
    }

    const fallback = PURPOSE_FALLBACKS[purpose].find((mode) => available.includes(mode));
    if (fallback) {
      return fallback;
    }

    const first = available[0];
    if (first) {
      return first;
    }

    throw new Error('No delegated modes available.');
  }

  private async maybeCreateWorkspace(options: {
    auth: DelegationCredentials;
    provider: string;
    purpose: DelegationPurpose;
    baseCwd: string;
    label: string;
    forceIsolation: boolean;
  }): Promise<IsolatedWorkspace | null> {
    const manager = this.config.worktreeManager;
    if (!manager) {
      return null;
    }

    const cliBacked =
      (options.provider === 'anthropic' && options.auth.tokenType === 'oauth') ||
      (options.provider === 'openai' && options.auth.tokenType === 'bearer');
    const shouldIsolate =
      options.forceIsolation ||
      cliBacked ||
      options.purpose === 'execution' ||
      options.purpose === 'design' ||
      options.purpose === 'review';

    if (!shouldIsolate) {
      return null;
    }

    try {
      return await manager.create(options.label, {
        baseCwd: options.baseCwd,
      });
    } catch {
      return null;
    }
  }

  private resolveVerificationMode(
    purpose: DelegationPurpose,
    requested: VerificationMode | undefined,
  ): VerificationMode {
    if (requested) {
      return requested;
    }

    if (purpose === 'execution' || purpose === 'design' || purpose === 'review') {
      return 'checks';
    }

    return 'none';
  }
}
