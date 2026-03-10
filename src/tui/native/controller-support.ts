import type { DelegationPurpose } from '../../core/delegation.js';
import type { NamedMode } from '../../core/types.js';
import { HARNESS_MODES, MODE_ORDER } from '../shared/theme.js';

export interface DelegationHookContextInput {
  provider: string;
  model: string;
  mode: NamedMode;
  purpose: DelegationPurpose;
  cwd: string;
  localSessionId?: string;
  remoteSessionId?: string;
  usage?: {
    input: number;
    output: number;
    cacheReadInput?: number;
    cacheWriteInput?: number;
  };
  durationMs?: number;
  status?: 'ok' | 'error';
  error?: string;
}

export interface AgentActivityHeartbeatItem {
  id?: string;
  label: string;
  mode?: NamedMode | null;
  purpose?: string | null;
  status: 'queued' | 'running' | 'verifying' | 'done' | 'error';
  detail?: string | null;
  workspacePath?: string | null;
  updatedAt?: number;
}

export const parseNamedMode = (value: unknown): NamedMode | null => {
  if (value === 'jennie' || value === 'lisa' || value === 'rosé' || value === 'jisoo') {
    return value;
  }

  return null;
};

export const findModeForProviderModel = (
  provider: string | undefined,
  model: string | undefined,
): NamedMode | null => {
  if (!provider && !model) {
    return null;
  }

  for (const mode of MODE_ORDER) {
    const modeConfig = HARNESS_MODES[mode];
    if (provider && model && modeConfig?.provider === provider && modeConfig.model === model) {
      return mode;
    }
  }

  if (provider) {
    for (const mode of MODE_ORDER) {
      if (HARNESS_MODES[mode]?.provider === provider) {
        return mode;
      }
    }
  }

  if (model) {
    for (const mode of MODE_ORDER) {
      if (HARNESS_MODES[mode]?.model === model) {
        return mode;
      }
    }
  }

  return null;
};

export const readSessionHeaderMode = (metadata: unknown): NamedMode | null => {
  if (typeof metadata !== 'object' || metadata === null) {
    return null;
  }

  return parseNamedMode((metadata as Record<string, unknown>).mode);
};

export const buildOrchestratorContract = (prompt: string | null): string => {
  const normalized = prompt?.trim();
  if (!normalized) {
    return '';
  }

  return ['<orchestrator_contract>', normalized, '</orchestrator_contract>'].join('\n');
};

export const buildDelegationHookContext = (
  input: DelegationHookContextInput,
  extras: Record<string, unknown> = {},
): Record<string, unknown> => ({
  provider: input.provider,
  model: input.model,
  sessionId: input.localSessionId,
  delegatedSessionId: input.localSessionId,
  remoteSessionId: input.remoteSessionId ?? null,
  requestMode: input.mode,
  delegationPurpose: input.purpose,
  cwd: input.cwd,
  inputTokens: input.usage?.input,
  outputTokens: input.usage?.output,
  cacheReadInputTokens: input.usage?.cacheReadInput,
  cacheWriteInputTokens: input.usage?.cacheWriteInput,
  durationMs: input.durationMs,
  status: input.status,
  error: input.error,
  ...extras,
});

const previewInline = (value: string, maxLength: number): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const activityStatusPriority = (status: AgentActivityHeartbeatItem['status']): number => {
  if (status === 'running' || status === 'verifying') {
    return 0;
  }
  if (status === 'queued') {
    return 1;
  }
  if (status === 'error') {
    return 2;
  }
  return 3;
};

const formatHeartbeatLabel = (item: AgentActivityHeartbeatItem): string => {
  const modeLabel = item.mode ? HARNESS_MODES[item.mode]?.label ?? item.mode.toUpperCase() : null;
  const trimmed = item.label.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }

  if (modeLabel) {
    return modeLabel;
  }

  if (item.purpose?.trim()) {
    return item.purpose.trim();
  }

  return 'worker';
};

export const formatAgentActivityHeartbeat = (input: {
  label: string;
  elapsedMs: number;
  activities: AgentActivityHeartbeatItem[];
}): string => {
  if (input.activities.length === 0) {
    return `${input.label} running`;
  }

  const counts = {
    queued: 0,
    running: 0,
    verifying: 0,
    done: 0,
    error: 0,
  };
  for (const item of input.activities) {
    counts[item.status] += 1;
  }

  const summary = [
    counts.running > 0 ? `${counts.running} running` : null,
    counts.verifying > 0 ? `${counts.verifying} verifying` : null,
    counts.queued > 0 ? `${counts.queued} queued` : null,
    counts.done > 0 ? `${counts.done} done` : null,
    counts.error > 0 ? `${counts.error} error` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  const details = input.activities
    .slice()
    .sort((left, right) => {
      return (
        activityStatusPriority(left.status) - activityStatusPriority(right.status) ||
        (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      );
    })
    .slice(0, 3)
    .map((item) => {
      const detail = item.detail?.trim() || item.workspacePath?.trim() || item.status;
      return `${formatHeartbeatLabel(item)}: ${previewInline(detail, 42)}`;
    })
    .join(' | ');

  const elapsedSeconds = Math.max(1, Math.round(input.elapsedMs / 1000));
  return [input.label, `${elapsedSeconds}s`, summary || 'running', details || null]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
};
