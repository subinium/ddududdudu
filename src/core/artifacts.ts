import type { DelegationPurpose } from './delegation.js';
import type { VerificationSummary } from './verifier.js';
import type {
  WorkflowArtifact,
  WorkflowArtifactKind,
  WorkflowArtifactPayload,
} from './workflow-state.js';

const previewText = (value: string, maxLength: number = 220): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const cleanItems = (values: string[] | undefined, limit: number = 5): string[] | undefined => {
  if (!values || values.length === 0) {
    return undefined;
  }

  const normalized = Array.from(
    new Set(
      values
        .map((value) => value.replace(/\s+/g, ' ').trim())
        .filter((value) => value.length > 0),
    ),
  ).slice(0, limit);

  return normalized.length > 0 ? normalized : undefined;
};

const extractHighlights = (value: string, limit: number = 5): string[] => {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const listItems = lines
    .filter((line) => /^([-*]|\d+\.)\s+/.test(line))
    .map((line) => line.replace(/^([-*]|\d+\.)\s+/, '').trim());

  if (listItems.length > 0) {
    return cleanItems(listItems, limit) ?? [];
  }

  const sentences = value
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return cleanItems(sentences, limit) ?? [];
};

const buildVerificationPayload = (
  verification: VerificationSummary | undefined,
): WorkflowArtifactPayload['verification'] | undefined => {
  if (!verification) {
    return undefined;
  }

  return {
    status: verification.status,
    summary: previewText(verification.summary, 220),
    changedFiles: cleanItems(verification.changedFiles, 6),
    commands: cleanItems(
      verification.commands
        .filter((command) => !command.ok)
        .map((command) => `${command.command}${command.exitCode === null ? '' : ` (exit ${command.exitCode})`}`),
      4,
    ),
  };
};

export const buildArtifactPayload = (input: {
  kind: WorkflowArtifactKind;
  purpose?: DelegationPurpose | 'general';
  task?: string;
  prompt?: string;
  summary?: string;
  strategy?: 'parallel' | 'sequential' | 'delegate';
  files?: string[];
  verification?: VerificationSummary;
  workspaceApply?: {
    applied: boolean;
    empty: boolean;
    summary: string;
    error?: string;
    path?: string | null;
  } | null;
  notes?: string[];
}): WorkflowArtifactPayload | undefined => {
  const highlights = extractHighlights(input.summary ?? '', 5);
  const payload: WorkflowArtifactPayload = {
    purpose: input.purpose,
    task: input.task ? previewText(input.task, 180) : undefined,
    prompt: input.prompt ? previewText(input.prompt, 220) : undefined,
    strategy: input.strategy,
    files: cleanItems(input.files, 6),
    notes: cleanItems(input.notes, 6),
    verification: buildVerificationPayload(input.verification),
    workspaceApply: input.workspaceApply
      ? {
          applied: input.workspaceApply.applied,
          empty: input.workspaceApply.empty,
          summary: previewText(input.workspaceApply.summary, 200),
          error: input.workspaceApply.error ? previewText(input.workspaceApply.error, 200) : undefined,
          path: input.workspaceApply.path ?? undefined,
        }
      : undefined,
  };

  switch (input.kind) {
    case 'plan':
      payload.planSteps = cleanItems(highlights, 5);
      payload.nextSteps = cleanItems(highlights.slice(0, 3), 3);
      break;
    case 'review':
      payload.risks = cleanItems(highlights, 5);
      break;
    case 'patch':
      payload.decisions = cleanItems(highlights, 4);
      payload.nextSteps = cleanItems(highlights.slice(0, 3), 3);
      break;
    case 'design':
      payload.decisions = cleanItems(highlights, 5);
      break;
    case 'research':
      payload.findings = cleanItems(highlights, 5);
      break;
    case 'briefing':
      payload.nextSteps = cleanItems(highlights, 4);
      break;
    case 'answer':
    default:
      payload.notes = cleanItems([...(payload.notes ?? []), ...highlights], 5);
      break;
  }

  const hasContent = Object.values(payload).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined,
  );

  return hasContent ? payload : undefined;
};

const payloadLines = (payload: WorkflowArtifactPayload | undefined): string[] => {
  if (!payload) {
    return [];
  }

  const lines: string[] = [];

  if (payload.purpose) {
    lines.push(`purpose: ${payload.purpose}`);
  }
  if (payload.task) {
    lines.push(`task: ${payload.task}`);
  }
  if (payload.strategy) {
    lines.push(`strategy: ${payload.strategy}`);
  }
  if (payload.files && payload.files.length > 0) {
    lines.push(`files: ${payload.files.join(', ')}`);
  }
  if (payload.planSteps && payload.planSteps.length > 0) {
    lines.push(...payload.planSteps.map((step) => `plan_step: ${step}`));
  }
  if (payload.findings && payload.findings.length > 0) {
    lines.push(...payload.findings.map((item) => `finding: ${item}`));
  }
  if (payload.risks && payload.risks.length > 0) {
    lines.push(...payload.risks.map((item) => `risk: ${item}`));
  }
  if (payload.decisions && payload.decisions.length > 0) {
    lines.push(...payload.decisions.map((item) => `decision: ${item}`));
  }
  if (payload.nextSteps && payload.nextSteps.length > 0) {
    lines.push(...payload.nextSteps.map((item) => `next_step: ${item}`));
  }
  if (payload.notes && payload.notes.length > 0) {
    lines.push(...payload.notes.map((item) => `note: ${item}`));
  }
  if (payload.verification) {
    lines.push(`verification: ${payload.verification.status} · ${payload.verification.summary}`);
    if (payload.verification.changedFiles?.length) {
      lines.push(`verification_files: ${payload.verification.changedFiles.join(', ')}`);
    }
    if (payload.verification.commands?.length) {
      lines.push(...payload.verification.commands.map((command) => `verification_command: ${command}`));
    }
  }
  if (payload.workspaceApply) {
    lines.push(
      `apply: ${payload.workspaceApply.applied ? 'applied' : payload.workspaceApply.empty ? 'empty' : 'failed'} · ${payload.workspaceApply.summary}`,
    );
    if (payload.workspaceApply.error) {
      lines.push(`apply_error: ${payload.workspaceApply.error}`);
    }
    if (payload.workspaceApply.path) {
      lines.push(`workspace: ${payload.workspaceApply.path}`);
    }
  }

  return lines;
};

export const formatArtifactContextLine = (artifact: WorkflowArtifact, maxLength: number = 180): string => {
  const payloadSummary = payloadLines(artifact.payload)[0];
  const best = payloadSummary ?? artifact.summary;
  return `[${artifact.kind}] ${artifact.title} · ${previewText(best, maxLength)}`;
};

export const formatArtifactForHandoff = (artifact: WorkflowArtifact): string => {
  const attrs = [
    `kind="${artifact.kind}"`,
    `title="${artifact.title.replace(/"/g, '\'')}"`,
    `source="${artifact.source}"`,
    artifact.mode ? `mode="${artifact.mode}"` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ');

  const lines = payloadLines(artifact.payload);
  const body = lines.length > 0
    ? lines.join('\n')
    : previewText(artifact.summary, 280);

  return `<artifact ${attrs}>\n${body}\n</artifact>`;
};

export const formatArtifactForInspector = (artifact: WorkflowArtifact): string[] => {
  const mode = artifact.mode ? ` · ${artifact.mode}` : '';
  const lines = [`[${artifact.kind}] ${artifact.title}${mode}`, `source: ${artifact.source}`];
  const payload = payloadLines(artifact.payload);
  if (payload.length > 0) {
    lines.push(...payload);
  } else {
    lines.push(artifact.summary);
  }
  return lines;
};
