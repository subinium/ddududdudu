import type { DelegationPurpose } from './delegation.js';
import type { NamedMode } from './types.js';
import type { VerificationMode } from './verifier.js';
import type { WorkflowArtifactKind } from './workflow-state.js';

export type SpecialistRole =
  | 'coordinator'
  | 'planner'
  | 'explorer'
  | 'librarian'
  | 'executor'
  | 'designer'
  | 'reviewer'
  | 'oracle';

export interface SpecialistRoleProfile {
  id: SpecialistRole;
  label: string;
  purpose: DelegationPurpose | 'general';
  preferredModes: NamedMode[];
  deliverable: WorkflowArtifactKind;
  readOnly: boolean;
  verificationMode: VerificationMode;
  systemPrompt: string;
}

const ROLE_PROFILES: Record<SpecialistRole, SpecialistRoleProfile> = {
  coordinator: {
    id: 'coordinator',
    label: 'coordinator',
    purpose: 'review',
    preferredModes: ['jennie', 'rosé', 'lisa'],
    deliverable: 'briefing',
    readOnly: true,
    verificationMode: 'none',
    systemPrompt:
      'Coordinate specialist workers, merge their outputs, and keep the result grounded in verification and explicit tradeoffs.',
  },
  planner: {
    id: 'planner',
    label: 'planner',
    purpose: 'planning',
    preferredModes: ['rosé', 'jennie', 'lisa'],
    deliverable: 'plan',
    readOnly: true,
    verificationMode: 'none',
    systemPrompt:
      'Clarify scope, assumptions, constraints, success criteria, and sequencing before execution. Surface missing information instead of guessing.',
  },
  explorer: {
    id: 'explorer',
    label: 'explorer',
    purpose: 'research',
    preferredModes: ['lisa', 'rosé', 'jennie'],
    deliverable: 'research',
    readOnly: true,
    verificationMode: 'none',
    systemPrompt:
      'Inspect the codebase quickly and precisely. Map affected files, symbols, interfaces, and failure hotspots without editing files.',
  },
  librarian: {
    id: 'librarian',
    label: 'librarian',
    purpose: 'research',
    preferredModes: ['rosé', 'jennie', 'lisa'],
    deliverable: 'research',
    readOnly: true,
    verificationMode: 'none',
    systemPrompt:
      'Collect repo-specific guidance, docs, rules, and configuration constraints. Prefer local docs and instructions over external assumptions.',
  },
  executor: {
    id: 'executor',
    label: 'executor',
    purpose: 'execution',
    preferredModes: ['lisa', 'jennie', 'rosé'],
    deliverable: 'patch',
    readOnly: false,
    verificationMode: 'checks',
    systemPrompt:
      'Implement the smallest safe change set that satisfies the task. Keep edits focused, concrete, and verification-ready.',
  },
  designer: {
    id: 'designer',
    label: 'designer',
    purpose: 'design',
    preferredModes: ['jisoo', 'rosé', 'lisa'],
    deliverable: 'design',
    readOnly: false,
    verificationMode: 'checks',
    systemPrompt:
      'Refine interface direction, interaction quality, and UX tradeoffs. If code changes are needed, keep them scoped to the design task.',
  },
  reviewer: {
    id: 'reviewer',
    label: 'reviewer',
    purpose: 'review',
    preferredModes: ['jennie', 'rosé', 'lisa'],
    deliverable: 'review',
    readOnly: true,
    verificationMode: 'checks',
    systemPrompt:
      'Review outputs for correctness, regressions, verification gaps, and hidden risks. Be explicit about blockers and follow-up actions.',
  },
  oracle: {
    id: 'oracle',
    label: 'oracle',
    purpose: 'oracle',
    preferredModes: ['jennie', 'rosé', 'lisa'],
    deliverable: 'review',
    readOnly: true,
    verificationMode: 'none',
    systemPrompt:
      'Act as a strong second opinion. Challenge weak assumptions, highlight tradeoffs, and return the clearest defensible recommendation.',
  },
};

export const getSpecialistRoleProfile = (role: SpecialistRole): SpecialistRoleProfile => ROLE_PROFILES[role];

export const resolveModeForSpecialistRole = (
  role: SpecialistRole,
  availableModes: NamedMode[],
  fallback?: NamedMode | null,
): NamedMode | null => {
  const profile = getSpecialistRoleProfile(role);
  const preferred = profile.preferredModes.find((mode) => availableModes.includes(mode));
  if (preferred) {
    return preferred;
  }

  if (fallback && availableModes.includes(fallback)) {
    return fallback;
  }

  return availableModes[0] ?? null;
};

export const formatSpecialistLabel = (
  role: SpecialistRole,
  mode?: NamedMode | null,
): string => {
  const profile = getSpecialistRoleProfile(role);
  if (!mode) {
    return profile.label;
  }

  const modeLabel = `${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;
  return `${modeLabel} · ${profile.label}`;
};

export const buildSpecialistPrompt = (
  role: SpecialistRole,
  taskLabel?: string | null,
  successCriteria?: string[],
): string => {
  const profile = getSpecialistRoleProfile(role);
  const sections = [profile.systemPrompt];

  if (profile.readOnly) {
    sections.push('This is a read-only specialist role. Prefer inspection, analysis, and concrete guidance over editing or applying changes.');
  }

  if (taskLabel && taskLabel.trim().length > 0) {
    sections.push(`Focused task: ${taskLabel.trim()}`);
  }

  if (successCriteria && successCriteria.length > 0) {
    sections.push(
      'Success criteria:',
      ...successCriteria.map((criterion) => `- ${criterion}`),
    );
  }

  return sections.join('\n');
};
