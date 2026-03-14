import type { ApiMessage, ToolStateUpdate } from '../api/anthropic-client.js';
import { createClient } from '../api/client-factory.js';
import { formatArtifactForHandoff } from './artifacts.js';
import { ExecutionScheduler, type ExecutionSchedulerConfig } from './execution-scheduler.js';
import { resolveModeBinding } from './mode-resolution.js';
import type { SessionManager } from './session.js';
import { buildSpecialistPrompt, type SpecialistRole } from './specialist-roles.js';
import type { NamedMode, SessionEntry } from './types.js';
import type { VerificationMode, VerificationSummary } from './verifier.js';
import { VerificationRunner } from './verifier.js';
import type { WorkflowArtifact, WorkflowArtifactKind } from './workflow-state.js';
import type {
  IsolatedWorkspace,
  WorkspaceApplyResult,
  WorkspaceCleanupResult,
  WorktreeManager,
} from './worktree-manager.js';

export interface DelegationCredentials {
  token: string;
  tokenType: string;
  source: string;
}

export type DelegationPurpose = 'general' | 'execution' | 'planning' | 'research' | 'review' | 'design' | 'oracle';

export interface DelegationRequest {
  prompt: string;
  purpose?: DelegationPurpose;
  requestedArtifactKind?: WorkflowArtifactKind;
  successCriteria?: string[];
  roleProfile?: SpecialistRole | null;
  taskLabel?: string | null;
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
  readOnly?: boolean;
  contextSnapshot?: string;
  artifacts?: WorkflowArtifact[];
}

export interface DelegationHandlers {
  onText?: (text: string) => void;
  onToolState?: (states: ToolStateUpdate[]) => void;
  onVerificationState?: (state: { status: 'running' | 'passed' | 'failed' | 'skipped'; summary?: string }) => void;
  onExecutionState?: (detail: string) => void;
  onApiCallStart?: (input: {
    provider: string;
    model: string;
    mode: NamedMode;
    purpose: DelegationPurpose;
    cwd: string;
    localSessionId?: string;
  }) => Promise<void> | void;
  onApiCallComplete?: (input: {
    provider: string;
    model: string;
    mode: NamedMode;
    purpose: DelegationPurpose;
    cwd: string;
    localSessionId?: string;
    remoteSessionId?: string;
    usage: DelegationResult['usage'];
    durationMs: number;
    status: 'ok' | 'error';
    error?: string;
  }) => Promise<void> | void;
  signal?: AbortSignal;
}

export interface DelegationResult {
  text: string;
  mode: NamedMode;
  provider: string;
  model: string;
  purpose: DelegationPurpose;
  requestedArtifactKind?: WorkflowArtifactKind;
  successCriteria?: string[];
  localSessionId?: string;
  remoteSessionId?: string;
  cwd: string;
  workspace?: IsolatedWorkspace | null;
  workspaceApply?: WorkspaceApplyResult | null;
  workspaceCleanup?: WorkspaceCleanupResult | null;
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
  systemPrompt: string;
}

interface DelegationRuntimeConfig {
  cwd: string;
  availableProviders: Map<string, DelegationCredentials>;
  sessionManager?: SessionManager | null;
  resolveModel?: (mode: NamedMode) => string;
  worktreeManager?: WorktreeManager | null;
  executionSchedulerConfig?: Partial<ExecutionSchedulerConfig>;
  defaultMaxTokens?: number;
}

const MODE_PROFILES: Record<NamedMode, DelegationModeProfile> = {
  jennie: {
    mode: 'jennie',
    systemPrompt: [
      'You are JENNIE inside ddudu — the orchestration and verification anchor.',
      'Coordinate multi-step work by decomposing tasks, delegating to specialists, and merging their results into a coherent outcome.',
      'After every meaningful change, enforce the verification loop: run lint_runner, test_runner, and build_runner before declaring success.',
      'When synthesizing results from multiple sources or agents, resolve contradictions explicitly and cite which source each conclusion came from.',
      'Return crisp decisions. If something is ambiguous, surface the ambiguity and your recommended resolution rather than guessing silently.',
    ].join(' '),
  },
  lisa: {
    mode: 'lisa',
    systemPrompt: [
      'You are LISA inside ddudu — the fast execution engine.',
      'Minimize deliberation: read the relevant code, make the change, verify it works, and move on.',
      'Prefer direct tool use over planning documents. If a task can be done in one tool call, do not decompose it further.',
      'When multiple independent edits are needed, execute them in parallel rather than sequentially.',
      'Run verification after edits but keep the feedback loop tight — fix failures immediately rather than reporting them for later.',
    ].join(' '),
  },
  rosé: {
    mode: 'rosé',
    systemPrompt: [
      'You are ROSÉ inside ddudu — the planning and architecture specialist.',
      'Before implementing, analyze the request: identify affected modules, data flow, edge cases, and potential regressions.',
      'Surface tradeoffs explicitly — performance vs readability, scope vs risk, quick fix vs proper refactor — and recommend one path with reasoning.',
      'When reviewing architecture, check for: single responsibility violations, hidden coupling between modules, missing error boundaries, and untested paths.',
      'Produce plans that are concrete enough to execute: file paths, function signatures, and verification steps, not abstract descriptions.',
    ].join(' '),
  },
  jisoo: {
    mode: 'jisoo',
    systemPrompt: [
      'You are JISOO inside ddudu — the design and UX specialist.',
      'Evaluate interfaces for consistency, accessibility, and visual hierarchy. Flag violations of the project design system.',
      'When building UI, ensure component states are complete: loading, empty, error, and populated. Do not ship a happy-path-only interface.',
      'Check accessibility basics: keyboard navigation, color contrast (WCAG AA minimum), semantic HTML, and ARIA labels where needed.',
      'Maintain visual consistency with the existing palette and spacing system. When proposing new patterns, show how they relate to what already exists.',
    ].join(' '),
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

const normalizeProviderMap = (providers: Map<string, DelegationCredentials>): Map<string, DelegationCredentials> => {
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
  if (/\b(ui|ux|design|layout|spacing|typography|visual|a11y|accessibility|color)\b/.test(lower)) {
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

const buildSessionEntry = (request: DelegationRequest, result: DelegationResult): SessionEntry => {
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
      requestedArtifactKind: result.requestedArtifactKind,
      successCriteria: result.successCriteria,
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

const buildDelegationPrompt = (request: DelegationRequest, purpose: DelegationPurpose): string => {
  const sections: string[] = [`Task purpose: ${purpose}`];

  if (request.roleProfile) {
    sections.push('<role_profile>', `role: ${request.roleProfile}`);
    if (request.taskLabel) {
      sections.push(`task: ${request.taskLabel}`);
    }
    sections.push('</role_profile>');
  }

  if (request.requestedArtifactKind) {
    sections.push(
      '<requested_deliverable>',
      `kind: ${request.requestedArtifactKind}`,
      'Return the result in a shape that fits this deliverable kind.',
      '</requested_deliverable>',
    );
  }

  if (request.successCriteria && request.successCriteria.length > 0) {
    sections.push(
      '<success_criteria>',
      ...request.successCriteria.map((criterion) => `- ${criterion}`),
      '</success_criteria>',
    );
  }

  if (purpose === 'planning') {
    sections.push(
      '<planning_protocol>',
      'First clarify scope, assumptions, constraints, success criteria, and open questions before proposing execution.',
      'If critical information is missing, surface that gap explicitly instead of pretending the plan is settled.',
      '</planning_protocol>',
    );
  }

  if (request.artifacts && request.artifacts.length > 0) {
    sections.push(
      '<handoff_artifacts>',
      ...request.artifacts.map((artifact) => formatArtifactForHandoff(artifact)),
      '</handoff_artifacts>',
    );
  }

  sections.push('<task>', request.prompt.trim(), '</task>');
  return sections.join('\n\n');
};

export class DelegationRuntime {
  private readonly config: DelegationRuntimeConfig;
  private readonly providers: Map<string, DelegationCredentials>;
  private readonly executionScheduler: ExecutionScheduler;

  public constructor(config: DelegationRuntimeConfig) {
    this.config = config;
    this.providers = normalizeProviderMap(config.availableProviders);
    this.executionScheduler = new ExecutionScheduler(config.executionSchedulerConfig ?? {});
  }

  public listAvailableModes(): NamedMode[] {
    return (Object.keys(MODE_PROFILES) as NamedMode[]).filter((mode) => {
      const binding = resolveModeBinding(mode, (provider) => {
        const auth = this.providers.get(provider);
        return Boolean(auth && !auth.source.includes(':stale'));
      });
      const auth = this.providers.get(binding.provider);
      return Boolean(auth && !auth.source.includes(':stale'));
    });
  }

  public async run(request: DelegationRequest, handlers: DelegationHandlers = {}): Promise<DelegationResult> {
    const purpose = request.purpose ?? inferPurposeFromPrompt(request.prompt);
    const mode = this.resolveMode(request.preferredMode, purpose);
    const profile = MODE_PROFILES[mode];
    const binding = resolveModeBinding(mode, (provider) => {
      const auth = this.providers.get(provider);
      return Boolean(auth && !auth.source.includes(':stale'));
    });
    const provider = binding.provider;
    const auth = this.providers.get(provider);

    if (!auth) {
      throw new Error(
        `No auth available for delegated mode ${mode} (${provider}). ` +
          `Run 'ddudu auth login ${provider === 'anthropic' ? 'claude' : provider === 'openai' ? 'codex' : provider}' to authenticate.`,
      );
    }

    const model = request.preferredModel ?? this.config.resolveModel?.(mode) ?? binding.model;
    const baseCwd = request.cwd ?? this.config.cwd;
    const workspace = await this.maybeCreateWorkspace({
      auth,
      provider,
      purpose,
      baseCwd,
      label: request.isolatedLabel ?? [mode, purpose, request.parentSessionId?.slice(0, 8)].filter(Boolean).join('-'),
      forceIsolation: request.forceIsolation ?? false,
      readOnly: request.readOnly ?? false,
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
    let workspaceCleanup: WorkspaceCleanupResult | null = null;
    const writeIntent =
      request.readOnly === false ||
      request.applyWorkspaceChanges === true ||
      ((purpose === 'execution' || purpose === 'design') && request.readOnly !== true);
    const writeKey = writeIntent ? baseCwd : null;

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
      const combinedSystemPrompt = [
        profile.systemPrompt,
        request.roleProfile
          ? buildSpecialistPrompt(request.roleProfile, request.taskLabel, request.successCriteria)
          : null,
        request.systemPrompt,
        request.contextSnapshot,
      ]
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n');
      const executionLease = await this.executionScheduler.acquire({
        provider,
        writeKey,
        signal: handlers.signal,
        onWait: handlers.onExecutionState,
      });
      try {
        await handlers.onApiCallStart?.({
          provider,
          model,
          mode,
          purpose,
          cwd: effectiveCwd,
          localSessionId,
        });
        for await (const event of client.stream(messages, {
          systemPrompt: combinedSystemPrompt,
          model,
          maxTokens: request.maxTokens ?? this.config.defaultMaxTokens ?? 8192,
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
      } finally {
        await executionLease.release();
      }

      const verificationMode = this.resolveVerificationMode(purpose, request.verificationMode);
      if (verificationMode !== 'none') {
        handlers.onVerificationState?.({ status: 'running', summary: `verification ${verificationMode}` });
        const verificationLease = await this.executionScheduler.acquire({
          resource: 'verification',
          signal: handlers.signal,
          onWait: handlers.onExecutionState,
        });
        try {
          verification = await new VerificationRunner(effectiveCwd).run(verificationMode);
        } finally {
          await verificationLease.release();
        }
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
        workspaceApply = (await this.config.worktreeManager?.applyToBase(workspace)) ?? null;
      }

      if (workspace && this.config.worktreeManager) {
        const inspection = await this.config.worktreeManager.inspect(workspace);
        const shouldCleanup =
          workspaceApply?.applied === true || workspaceApply?.empty === true || !inspection.hasChanges;
        if (shouldCleanup) {
          workspaceCleanup = await this.config.worktreeManager.cleanup(workspace);
        }
      }

      const result: DelegationResult = {
        text: text.trim(),
        mode,
        provider,
        model,
        purpose,
        requestedArtifactKind: request.requestedArtifactKind,
        successCriteria: request.successCriteria,
        localSessionId,
        remoteSessionId,
        cwd: effectiveCwd,
        workspace: workspaceCleanup?.removed ? null : workspace,
        workspaceApply,
        workspaceCleanup,
        verification,
        usage,
        durationMs: Date.now() - start,
      };

      await handlers.onApiCallComplete?.({
        provider,
        model,
        mode,
        purpose,
        cwd: effectiveCwd,
        localSessionId,
        remoteSessionId,
        usage,
        durationMs: result.durationMs,
        status: 'ok',
      });

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

      await handlers.onApiCallComplete?.({
        provider,
        model,
        mode,
        purpose,
        cwd: effectiveCwd,
        localSessionId,
        remoteSessionId,
        usage,
        durationMs: Date.now() - start,
        status: 'error',
        error: serializeError(error),
      });

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
    readOnly: boolean;
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

    if (options.readOnly && options.purpose === 'research' && !options.forceIsolation) {
      return null;
    }

    if (!shouldIsolate) {
      return null;
    }

    try {
      return await manager.create(options.label, {
        baseCwd: options.baseCwd,
      });
    } catch (err: unknown) {
      console.error(
        `[delegation] workspace isolation failed for ${options.label}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
