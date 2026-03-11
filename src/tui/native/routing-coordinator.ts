import type { DelegationPurpose } from '../../core/delegation.js';
import { planWorkAllocation, type WorkAllocationPlan } from '../../core/work-allocation.js';
import type { NamedMode } from '../../core/types.js';
import { HARNESS_MODES } from '../shared/theme.js';

export interface AutoRouteDecision {
  kind: 'direct' | 'delegate' | 'team';
  reason: string;
  purpose?: DelegationPurpose;
  preferredMode?: NamedMode;
  strategy?: 'parallel' | 'sequential' | 'delegate';
  executionClass?: 'managed' | 'research_fast';
  repairAttempt?: number;
}

export interface TeamExecutionPlanDraft {
  allocation: WorkAllocationPlan;
  leadMode: NamedMode;
}

const normalizeSingleLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

export const classifyJennieAutoRoute = (
  prompt: string,
  availableModes: NamedMode[],
): AutoRouteDecision => {
  const normalized = normalizeSingleLine(prompt);
  const lower = normalized.toLowerCase();
  const wordCount = normalized.length > 0 ? normalized.split(/\s+/u).length : 0;
  const allocation = availableModes.length > 0
    ? planWorkAllocation(prompt, 'parallel', availableModes)
    : null;
  const unitCount = allocation?.units.length ?? 0;
  const readOnlyUnits = allocation?.units.filter((unit) => unit.readOnly).length ?? 0;
  const writeUnits = allocation?.units.filter((unit) => !unit.readOnly).length ?? 0;

  const hasDesign = /\b(ui|ux|design|layout|spacing|typography|visual|a11y|accessibility|color|interaction)\b|(?:디자인|레이아웃|타이포|접근성|색상|인터랙션)/u.test(lower);
  const hasPlanning = /\b(plan|planning|architecture|architect|strategy|roadmap|tradeoff|spec|design doc)\b|(?:계획|플랜|설계|아키텍처|전략|로드맵|스펙)/u.test(lower);
  const hasResearch = /\b(research|investigate|look into|survey|compare options|explore)\b|(?:리서치|조사|찾아|찾아줘|비교|탐색|분석해|알아봐)/u.test(lower);
  const hasReview = /\b(review|audit|verify|validation|regression|risk|critic|critique)\b|(?:리뷰|검토|검증|감사|리스크|회귀)/u.test(lower);
  const hasExecution = /\b(implement|build|fix|write|edit|refactor|patch|ship|code|change)\b|(?:구현|수정|고쳐|작성|편집|리팩터|패치|코드|변경)/u.test(lower);
  const explicitTeam = /\b(team|multi[- ]agent|orchestrate|delegate|parallel|sequential|split (this|it) up|break (this|it) down)\b|(?:팀으로|서브에이전트|멀티 에이전트|병렬|동시에|나눠서|분담)/u.test(lower);
  const multiStep =
    /(\b(plan|research|review|design|implement|fix)\b.*\b(and|then|also)\b.*\b(plan|research|review|design|implement|fix)\b)/u.test(lower) ||
    /\b(end-to-end|from scratch|full flow|across the repo|whole project|entire codebase)\b/u.test(lower) ||
    normalized.split(/\n+/u).length > 1;
  const repoWide =
    /\b(across the repo|entire repo|whole project|codebase|end-to-end|from scratch|full flow)\b/u.test(lower) ||
    /(?:전체 프로젝트|코드베이스|엔드투엔드|처음부터|전체 흐름)/u.test(lower) ||
    normalized.split(/\n+/u).length > 1;
  const purposeCount = [hasDesign, hasPlanning, hasResearch, hasReview, hasExecution].filter(Boolean).length;
  const shardableResearch = hasResearch && unitCount >= 2 && writeUnits === 0;
  const managedTeamWorthwhile =
    explicitTeam ||
    shardableResearch ||
    (repoWide && purposeCount >= 3 && unitCount >= 4 && writeUnits >= 1 && readOnlyUnits >= 2);

  if (wordCount <= 6 && purposeCount === 0) {
    return { kind: 'direct', reason: 'short direct prompt' };
  }

  if (managedTeamWorthwhile) {
    return {
      kind: 'team',
      strategy:
        allocation?.suggestedStrategy
        ?? (explicitTeam || (hasExecution && (hasPlanning || hasResearch || hasReview)) ? 'delegate' : 'parallel'),
      executionClass: shardableResearch ? 'research_fast' : 'managed',
      reason:
        explicitTeam
          ? 'explicit orchestration request'
          : shardableResearch
            ? 'itemized research benefits from parallel comparison'
            : 'broad repo-scale work benefits from specialist split',
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
      reason: 'planning or architecture request prefers a single coherent owner',
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
    if (multiStep || repoWide || wordCount >= 18) {
      return {
        kind: 'delegate',
        purpose: 'execution',
        preferredMode: 'lisa',
        reason: 'execution should start from the smallest executable unit',
      };
    }
    return { kind: 'direct', reason: 'single execution request' };
  }

  return { kind: 'direct', reason: 'no strong orchestration signal' };
};

export const formatAutoRouteNotice = (decision: AutoRouteDecision): string => {
  if (decision.kind === 'team') {
    return `Auto route · team ${decision.strategy ?? 'parallel'} · ${decision.reason}`;
  }

  const modeLabel = decision.preferredMode
    ? HARNESS_MODES[decision.preferredMode].label
    : 'Auto';
  const purpose = decision.purpose ?? 'general';
  return `Auto route · ${modeLabel} · ${purpose} · ${decision.reason}`;
};

export const shouldRunPlanningInterview = (
  prompt: string,
  decision: AutoRouteDecision,
): boolean => {
  if (decision.kind === 'direct') {
    return false;
  }

  if (decision.executionClass === 'research_fast') {
    return false;
  }

  const normalized = normalizeSingleLine(prompt);
  const lower = normalized.toLowerCase();
  const wordCount = normalized.length > 0 ? normalized.split(/\s+/u).length : 0;
  const hasExplicitConstraints =
    /\b(keep|preserve|avoid|without|must|should not|don't|do not|only|exactly)\b/u.test(lower);
  const hasExplicitSuccessCriteria =
    /\b(done|success|pass|green|working|ship|finish|complete|acceptance|criteria)\b/u.test(lower);
  const clearlySmall =
    wordCount <= 10 &&
    !/\b(across the repo|codebase|architecture|end-to-end|refactor|research|review|design)\b|(?:코드베이스|아키텍처|리서치|리뷰|디자인)/u.test(lower);

  if (clearlySmall) {
    return false;
  }

  if (decision.kind === 'team') {
    return wordCount >= 16 && (!hasExplicitConstraints || !hasExplicitSuccessCriteria);
  }

  return (
    decision.purpose === 'planning'
    || decision.purpose === 'design'
  );
};

export const createTeamExecutionPlanDraft = (
  task: string,
  strategy: 'parallel' | 'sequential' | 'delegate',
  availableModes: NamedMode[],
): TeamExecutionPlanDraft | null => {
  if (availableModes.length === 0) {
    return null;
  }

  const allocation = planWorkAllocation(task, strategy, availableModes);
  const leadMode =
    allocation.units.find((unit) => unit.role === 'planner' || unit.role === 'reviewer')?.preferredMode ??
    (availableModes.includes('jennie') ? 'jennie' : availableModes[0]);

  return {
    allocation,
    leadMode,
  };
};
