import { formatArtifactContextLine } from '../../core/artifacts.js';
import type { DelegationPurpose } from '../../core/delegation.js';
import type { MemoryScope } from '../../core/memory.js';
import { HARNESS_MODES } from '../shared/theme.js';

export interface ContextSnapshotOptions {
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

export interface TimedCacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface BuilderDeps {
  currentMode: string;
  provider: string;
  model: string;
  permissionProfile: string;
  workspacePath: string | null;
  sessionId: string | null;
  uncertainties: number;
  getRelevantFilesForPrompt: (
    prompt: string,
    purpose: DelegationPurpose | 'general',
    limit?: number,
  ) => Promise<string[]>;
  getArtifactsForPurpose: (
    purpose: DelegationPurpose | 'general',
    maxArtifacts: number,
  ) => Array<{ id: string; kind: string; mode?: 'jennie' | 'lisa' | 'rosé' | 'jisoo' }>;
  getCachedSelectedMemory: (scopes: MemoryScope[], maxChars: number) => Promise<string>;
  hasMeaningfulMemory: (value: string) => boolean;
  getChangedFiles: (limit: number) => Promise<string[]>;
  getBriefingSummary: () => Promise<{ summary: string; nextSteps: string[] } | null>;
  todos: Array<{ id: string; status: string; step: string }>;
  activeUncertainties: string[];
  activeAgents: Array<{
    id: string;
    mode?: 'jennie' | 'lisa' | 'rosé' | 'jisoo' | null;
    label: string;
    purpose?: string | null;
    status: string;
    detail?: string | null;
    updatedAt: number;
  }>;
  runningBackgroundJobs: Array<{ id: string; label: string; kind: string; detail?: string | null }>;
  previewText: (value: string, maxLength?: number) => string;
  getRequestMemoryScopes: (purpose: DelegationPurpose | 'general') => MemoryScope[];
  writeTimedCache: <T>(value: T, ttlMs: number) => TimedCacheEntry<T>;
  trimTimedMap: <T>(map: Map<string, TimedCacheEntry<T>>, maxEntries: number) => void;
}

export const buildPromptContextCacheKey = (
  deps: BuilderDeps,
  prompt: string | undefined,
  purpose: DelegationPurpose | 'general',
  options: Required<ContextSnapshotOptions>,
): string => {
  const activeAgents = deps.activeAgents
    .slice(0, 4)
    .map((item) => `${item.id}:${item.status}:${item.updatedAt}`)
    .join('|');
  const activeJobs = deps.runningBackgroundJobs
    .slice(0, 4)
    .map((job) => `${job.id}:${job.kind}`)
    .join('|');
  const todoSignature = deps.todos
    .slice(0, 8)
    .map((item) => `${item.id}:${item.status}`)
    .join('|');
  const artifactSignature = deps
    .getArtifactsForPurpose(purpose, 6)
    .map((artifact) => `${artifact.id}:${artifact.kind}`)
    .join('|');
  return JSON.stringify({
    prompt,
    purpose,
    options,
    mode: deps.currentMode,
    provider: deps.provider,
    model: deps.model,
    permission: deps.permissionProfile,
    workspace: deps.workspacePath,
    sessionId: deps.sessionId,
    todoSignature,
    artifactSignature,
    activeAgents,
    activeJobs,
    uncertaintyCount: deps.uncertainties,
  });
};

export const buildPromptContextSnapshot = async (
  deps: BuilderDeps,
  cache: Map<string, TimedCacheEntry<string>>,
  prompt?: string,
  purpose?: DelegationPurpose | 'general',
  options: ContextSnapshotOptions = {},
): Promise<string> => {
  const parts: string[] = [];
  const effectivePurpose = purpose ?? (prompt ? 'general' : 'general');
  const snapshotOptions: Required<ContextSnapshotOptions> = {
    includeRelevantFiles: options.includeRelevantFiles ?? true,
    includeChangedFiles: options.includeChangedFiles ?? true,
    includeBriefing: options.includeBriefing ?? true,
    includePlan: options.includePlan ?? true,
    includeUncertainties:
      options.includeUncertainties ??
      (effectivePurpose === 'planning' || effectivePurpose === 'research' || effectivePurpose === 'review'),
    includeOperationalState:
      options.includeOperationalState ?? (effectivePurpose === 'planning' || effectivePurpose === 'general'),
    includeMemory: options.includeMemory ?? true,
    memoryScopes: options.memoryScopes ?? deps.getRequestMemoryScopes(effectivePurpose),
    maxArtifacts: options.maxArtifacts ?? (effectivePurpose === 'planning' || effectivePurpose === 'review' ? 4 : 3),
  };
  const cacheKey = buildPromptContextCacheKey(deps, prompt, effectivePurpose, snapshotOptions);
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  if (prompt) {
    parts.push(`request_focus: ${effectivePurpose}`);
    if (snapshotOptions.includeRelevantFiles) {
      const relevantFiles = await deps.getRelevantFilesForPrompt(prompt, effectivePurpose, 5);
      if (relevantFiles.length > 0) {
        parts.push('relevant_files:', ...relevantFiles.map((filePath) => `- ${filePath}`));
      }
    }
  }
  const relevantArtifacts = deps.getArtifactsForPurpose(effectivePurpose, snapshotOptions.maxArtifacts);
  if (relevantArtifacts.length > 0) {
    parts.push(
      ...relevantArtifacts.map((artifact) => {
        const mode = artifact.mode ? ` · ${HARNESS_MODES[artifact.mode].label}` : '';
        return `artifact: ${formatArtifactContextLine(artifact as never, 140)}${mode}`;
      }),
    );
  }
  if (snapshotOptions.includeMemory) {
    try {
      const selectedMemory = await deps.getCachedSelectedMemory(snapshotOptions.memoryScopes, 320);
      if (deps.hasMeaningfulMemory(selectedMemory)) {
        parts.push('<memory_selection>', selectedMemory, '</memory_selection>');
      }
    } catch {}
  }
  if (snapshotOptions.includeChangedFiles) {
    const changedFiles = await deps.getChangedFiles(8);
    if (changedFiles.length > 0) {
      parts.push('changed_files:', ...changedFiles.map((filePath) => `- ${filePath}`));
    }
  }
  if (snapshotOptions.includeBriefing) {
    const briefing = await deps.getBriefingSummary();
    if (briefing) {
      parts.push(
        `briefing_summary: ${briefing.summary}`,
        ...briefing.nextSteps.slice(0, 4).map((step) => `next_step: ${deps.previewText(step, 180)}`),
      );
    }
  }
  if (snapshotOptions.includePlan && deps.todos.length > 0) {
    parts.push(
      ...deps.todos
        .filter((item) => effectivePurpose === 'planning' || item.status !== 'completed')
        .slice(0, 5)
        .map((item) => `plan_item: [${item.status}] ${deps.previewText(item.step, 180)}`),
    );
  }
  if (snapshotOptions.includeUncertainties && deps.activeUncertainties.length > 0) {
    parts.push(...deps.activeUncertainties.slice(0, 3).map((item) => `uncertainty: ${deps.previewText(item, 180)}`));
  }
  if (snapshotOptions.includeOperationalState) {
    const activeAgents = deps.activeAgents
      .filter((item) => item.status === 'running' || item.status === 'verifying' || item.status === 'queued')
      .slice(0, 2);
    if (activeAgents.length > 0) {
      parts.push(
        ...activeAgents.map((item) => {
          const scope = [item.mode ? HARNESS_MODES[item.mode].label : item.label, item.purpose]
            .filter((part): part is string => Boolean(part))
            .join(' · ');
          const detail = item.detail ? ` · ${deps.previewText(item.detail, 100)}` : '';
          return `active_agent: ${scope} · ${item.status}${detail}`;
        }),
      );
    }
    if (deps.runningBackgroundJobs.length > 0) {
      parts.push(
        ...deps.runningBackgroundJobs.slice(0, 2).map((job) => {
          const detail = job.detail ? ` · ${deps.previewText(job.detail, 100)}` : '';
          return `background_job: ${job.label} · ${job.kind}${detail}`;
        }),
      );
    }
  }
  if (deps.workspacePath) {
    parts.push(`workspace: ${deps.workspacePath}`);
  }
  if (parts.length === 0) {
    return '';
  }
  const snapshot = `<context_snapshot>\n${parts.join('\n')}\n</context_snapshot>`;
  cache.set(cacheKey, deps.writeTimedCache(snapshot, 1200));
  deps.trimTimedMap(cache, 48);
  return snapshot;
};
