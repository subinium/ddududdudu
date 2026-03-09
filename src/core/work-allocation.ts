import { randomUUID } from 'node:crypto';

import type { DelegationPurpose } from './delegation.js';
import {
  getSpecialistRoleProfile,
  resolveModeForSpecialistRole,
  type SpecialistRole,
} from './specialist-roles.js';
import type { NamedMode } from './types.js';
import type { VerificationMode } from './verifier.js';
import type { WorkflowArtifactKind } from './workflow-state.js';

export interface WorkUnit {
  id: string;
  role: SpecialistRole;
  label: string;
  brief: string;
  purpose: DelegationPurpose | 'general';
  deliverable: WorkflowArtifactKind;
  preferredMode: NamedMode | null;
  readOnly: boolean;
  verificationMode: VerificationMode;
  successCriteria: string[];
}

export interface WorkAllocationPlan {
  units: WorkUnit[];
  suggestedStrategy: 'parallel' | 'sequential' | 'delegate';
}

const normalizeTask = (task: string): string => task.replace(/\s+/g, ' ').trim();

const detectTaskSignals = (task: string) => {
  const normalized = normalizeTask(task);
  const lower = normalized.toLowerCase();
  return {
    normalized,
    hasDesign: /\b(ui|ux|design|layout|spacing|typography|visual|a11y|accessibility|color|interaction)\b/u.test(lower),
    hasPlanning: /\b(plan|planning|architecture|architect|strategy|roadmap|tradeoff|spec|design doc)\b/u.test(lower),
    hasResearch: /\b(research|investigate|look into|survey|compare|explore|analyze)\b/u.test(lower),
    hasReview: /\b(review|audit|verify|validation|regression|risk|critic|critique)\b/u.test(lower),
    hasExecution: /\b(implement|build|fix|write|edit|refactor|patch|ship|code|change)\b/u.test(lower),
    docsHeavy: /\b(doc|docs|readme|contributing|rule|prompt|instruction|config|mcp|auth|provider|integration|guide)\b/u.test(lower),
    repoWide:
      /\b(across the repo|entire repo|whole project|codebase|end-to-end|from scratch|full flow)\b/u.test(lower) ||
      normalized.split(/\n+/u).length > 1,
  };
};

const createUnit = (
  role: SpecialistRole,
  label: string,
  brief: string,
  successCriteria: string[],
  availableModes: NamedMode[],
): WorkUnit => {
  const profile = getSpecialistRoleProfile(role);
  return {
    id: `${role}:${randomUUID().slice(0, 8)}`,
    role,
    label,
    brief,
    purpose: profile.purpose,
    deliverable: profile.deliverable,
    preferredMode: resolveModeForSpecialistRole(role, availableModes),
    readOnly: profile.readOnly,
    verificationMode: profile.verificationMode,
    successCriteria,
  };
};

const pushUniqueRole = (
  units: WorkUnit[],
  role: SpecialistRole,
  label: string,
  brief: string,
  successCriteria: string[],
  availableModes: NamedMode[],
): void => {
  if (units.some((unit) => unit.role === role)) {
    return;
  }

  units.push(createUnit(role, label, brief, successCriteria, availableModes));
};

export const planWorkAllocation = (
  task: string,
  requestedStrategy: 'parallel' | 'sequential' | 'delegate',
  availableModes: NamedMode[],
): WorkAllocationPlan => {
  const signals = detectTaskSignals(task);
  const units: WorkUnit[] = [];

  const needsPlanning =
    signals.hasPlanning || (signals.hasExecution && (signals.hasResearch || signals.docsHeavy || signals.repoWide));
  const needsExplorer = signals.hasExecution || signals.hasReview || signals.repoWide;
  const needsLibrarian = signals.docsHeavy || signals.hasPlanning || signals.hasResearch;
  const needsExecutor = signals.hasExecution || (!signals.hasPlanning && !signals.hasResearch && !signals.hasReview);
  const needsDesigner = signals.hasDesign;
  const needsReviewer = signals.hasReview || signals.hasExecution || signals.hasDesign;

  if (needsPlanning) {
    pushUniqueRole(
      units,
      'planner',
      'Define scope and success criteria',
      'Clarify scope, explicit constraints, success criteria, and an execution sequence before edits begin.',
      ['State scope, assumptions, and explicit success criteria.', 'Break the work into concrete sub-tasks.'],
      availableModes,
    );
  }

  if (needsExplorer) {
    pushUniqueRole(
      units,
      'explorer',
      'Map affected code paths',
      'Inspect the repository and identify the files, symbols, and failure hotspots most relevant to the task.',
      ['Name the primary files and symbols involved.', 'Call out likely hotspots or risky boundaries.'],
      availableModes,
    );
  }

  if (needsLibrarian) {
    pushUniqueRole(
      units,
      'librarian',
      'Collect repo rules and docs',
      'Read local docs, rules, prompts, and config so the rest of the run stays aligned with project-specific guidance.',
      ['Surface repo-specific instructions, config constraints, and compatibility requirements.'],
      availableModes,
    );
  }

  if (needsDesigner) {
    pushUniqueRole(
      units,
      'designer',
      'Shape the UI and UX direction',
      'Propose or implement the smallest design changes that improve usability, hierarchy, and interaction quality.',
      ['Describe the UX direction clearly.', 'Keep design changes scoped to the task.'],
      availableModes,
    );
  }

  if (needsExecutor) {
    pushUniqueRole(
      units,
      'executor',
      'Implement the smallest safe change set',
      'Make the minimal code changes required to satisfy the task without expanding scope.',
      ['Produce a concrete change set.', 'Keep the diff focused and verification-ready.'],
      availableModes,
    );
  }

  if (needsReviewer) {
    pushUniqueRole(
      units,
      'reviewer',
      'Review risks and verification gaps',
      'Review the merged work for regressions, hidden risks, and missing verification before completion.',
      ['List the highest-risk regressions or gaps.', 'State whether the result is ready to land.'],
      availableModes,
    );
  }

  const suggestedStrategy =
    units.some((unit) => unit.role === 'executor') &&
    units.some((unit) => unit.role === 'planner' || unit.role === 'explorer' || unit.role === 'librarian')
      ? 'delegate'
      : units.filter((unit) => unit.readOnly).length >= 2
        ? 'parallel'
        : requestedStrategy;

  return {
    units,
    suggestedStrategy,
  };
};
