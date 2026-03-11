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
  dependsOn: string[];
  handoffTo?: SpecialistRole;
}

export interface WorkAllocationPlan {
  units: WorkUnit[];
  suggestedStrategy: 'parallel' | 'sequential' | 'delegate';
}

const normalizeTask = (task: string): string => task.replace(/\s+/g, ' ').trim();

const KNOWN_FILE_EXTENSION_PATTERN = /\.(?:[cm]?[jt]sx?|json|md|rs|py|go|java|rb|php|c|cc|cpp|h|hpp|swift|kt|ya?ml)$/iu;

const uniqueValues = (values: string[]): string[] => Array.from(new Set(values));

const detectTaskSignals = (task: string) => {
  const normalized = normalizeTask(task);
  const lower = normalized.toLowerCase();
  return {
    normalized,
    hasDesign: /\b(ui|ux|design|layout|spacing|typography|visual|a11y|accessibility|color|interaction)\b|(?:디자인|레이아웃|타이포|접근성|색상|인터랙션)/u.test(lower),
    hasPlanning: /\b(plan|planning|architecture|architect|strategy|roadmap|tradeoff|spec|design doc)\b|(?:계획|플랜|설계|아키텍처|전략|로드맵|스펙)/u.test(lower),
    hasResearch: /\b(research|investigate|look into|survey|compare|explore|analyze)\b|(?:리서치|조사|찾아|찾아줘|비교|탐색|분석해|알아봐)/u.test(lower),
    hasReview: /\b(review|audit|verify|validation|regression|risk|critic|critique)\b|(?:리뷰|검토|검증|감사|리스크|회귀)/u.test(lower),
    hasExecution: /\b(implement|build|fix|write|edit|refactor|patch|ship|code|change)\b|(?:구현|수정|고쳐|작성|편집|리팩터|패치|코드|변경)/u.test(lower),
    docsHeavy: /\b(doc|docs|readme|contributing|rule|prompt|instruction|config|mcp|auth|provider|integration|guide)\b|(?:문서|리드미|가이드|규칙|설정|인증|프로바이더|통합)/u.test(lower),
    multiStep:
      /(\b(plan|research|review|design|implement|fix)\b.*\b(and|then|also)\b.*\b(plan|research|review|design|implement|fix)\b)/u.test(lower) ||
      normalized.split(/\n+/u).length > 1,
    repoWide:
      /\b(across the repo|entire repo|whole project|codebase|end-to-end|from scratch|full flow)\b|(?:전체 프로젝트|코드베이스|엔드투엔드|처음부터|전체 흐름)/u.test(lower) ||
      normalized.split(/\n+/u).length > 1,
  };
};

const isLikelyResearchSubjectToken = (value: string): boolean => {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/iu.test(normalized)) {
    return false;
  }
  if (normalized.includes('.') && KNOWN_FILE_EXTENSION_PATTERN.test(normalized)) {
    return false;
  }
  if (normalized.startsWith('http')) {
    return false;
  }
  return true;
};

export const extractResearchSubjects = (task: string): string[] => {
  const normalized = normalizeTask(task);
  const subjects: string[] = [];

  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._-]{1,31}(?:\s*\/\s*[a-z0-9][a-z0-9._-]{1,31}){1,7}/giu)) {
    const fragments = (match[0] ?? '')
      .split('/')
      .map((item) => item.trim())
      .filter((item) => isLikelyResearchSubjectToken(item));
    if (fragments.length >= 2) {
      subjects.push(...fragments);
    }
  }

  for (const match of normalized.matchAll(/([a-z0-9][a-z0-9._-]{1,31}(?:\s*,\s*[a-z0-9][a-z0-9._-]{1,31}){2,7})/giu)) {
    const fragments = (match[1] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => isLikelyResearchSubjectToken(item));
    if (fragments.length >= 3) {
      subjects.push(...fragments);
    }
  }

  return uniqueValues(subjects).slice(0, 6);
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
    dependsOn: [],
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
  const researchSubjects = extractResearchSubjects(task);

  if (
    signals.hasResearch
    && researchSubjects.length >= 2
    && !signals.hasExecution
    && !signals.hasDesign
    && !signals.hasReview
    && !signals.hasPlanning
  ) {
    return {
      units: researchSubjects.map((subject) =>
        createUnit(
          'explorer',
          `Research ${subject}`,
          `Investigate ${subject}, gather concrete facts, and return a concise comparison-ready briefing.`,
          [
            `Identify what ${subject} refers to.`,
            `Collect concrete facts or distinguishing signals for ${subject}.`,
            `Call out ambiguity, uncertainty, or missing evidence for ${subject}.`,
          ],
          availableModes,
        )),
      suggestedStrategy: 'parallel',
    };
  }

  const units: WorkUnit[] = [];

  const needsPlanning =
    signals.hasPlanning || (signals.hasExecution && (signals.repoWide || signals.multiStep) && (signals.hasResearch || signals.docsHeavy));
  const needsExplorer = signals.hasExecution || signals.hasReview || signals.repoWide;
  const needsLibrarian = signals.docsHeavy || signals.hasPlanning || signals.hasResearch;
  const needsExecutor = signals.hasExecution || (!signals.hasPlanning && !signals.hasResearch && !signals.hasReview);
  const needsDesigner = signals.hasDesign;
  const needsReviewer =
    signals.hasReview
    || signals.hasDesign
    || (signals.hasExecution && (signals.hasPlanning || signals.hasResearch || signals.docsHeavy || signals.repoWide));

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

  const planner = units.find((unit) => unit.role === 'planner');
  const explorer = units.find((unit) => unit.role === 'explorer');
  const librarian = units.find((unit) => unit.role === 'librarian');
  const designer = units.find((unit) => unit.role === 'designer');
  const executor = units.find((unit) => unit.role === 'executor');
  const reviewer = units.find((unit) => unit.role === 'reviewer');

  for (const unit of units) {
    if (!planner || unit.id === planner.id) {
      continue;
    }

    // Let discovery workers start immediately so planning does not become a full barrier.
    if (unit.role === 'explorer' || unit.role === 'librarian') {
      continue;
    }

    if (!unit.dependsOn.includes(planner.label)) {
      unit.dependsOn.push(planner.label);
    }
  }

  if (executor) {
    for (const dependency of [explorer, librarian, designer]) {
      if (dependency && !executor.dependsOn.includes(dependency.label)) {
        executor.dependsOn.push(dependency.label);
      }
    }
    executor.handoffTo = reviewer ? 'reviewer' : 'coordinator';
  }

  if (designer) {
    designer.handoffTo = executor ? 'executor' : reviewer ? 'reviewer' : 'coordinator';
  }

  if (explorer) {
    explorer.handoffTo = executor ? 'executor' : reviewer ? 'reviewer' : 'coordinator';
  }

  if (librarian) {
    librarian.handoffTo = executor ? 'executor' : reviewer ? 'reviewer' : 'coordinator';
  }

  if (reviewer) {
    for (const dependency of [executor, designer]) {
      if (dependency && !reviewer.dependsOn.includes(dependency.label)) {
        reviewer.dependsOn.push(dependency.label);
      }
    }
    reviewer.handoffTo = 'coordinator';
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
