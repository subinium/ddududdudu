export interface PromotionCandidate {
  content: string;
  sourceRunId?: string;
  changedFiles: string[];
  verificationStatus: 'passed' | 'failed' | 'skipped';
  artifactKind?: string;
  artifactPayload?: Record<string, unknown>;
}

export interface PromotionScore {
  stability: number;
  reuse: number;
  specificity: number;
  verification: number;
  novelty: number;
  composite: number;
}

export type PromotionDecision =
  | 'promote_semantic'
  | 'promote_procedural'
  | 'promote_episodic'
  | 'keep_working'
  | 'discard';

export interface MemoryEntryMetadata {
  confidence: number;
  sourceRunId?: string;
  promotedAt: string;
  score: PromotionScore;
}

const STABILITY_WEIGHT = 0.25;
const REUSE_WEIGHT = 0.3;
const SPECIFICITY_WEIGHT = 0.15;
const VERIFICATION_WEIGHT = 0.2;
const NOVELTY_WEIGHT = 0.1;

const PATH_PATTERN =
  /(?:^|\s)(?:[./~][^\s]+|[a-zA-Z0-9_-]+\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+(?:\.[a-zA-Z0-9]+)?)/g;
const COMMAND_PATTERN =
  /`[^`]+`|\b(?:npm|pnpm|yarn|bun|node|npx|tsx|tsc|vitest|jest|cargo|go|python|pip|make|docker|kubectl|gh|git|ddudu)\s+[\w./:-]+/gi;
const VALUE_PATTERN = /\b(?:v?\d+(?:\.\d+){0,2}|true|false|\d{2,})\b/gi;
const WORKFLOW_PATTERN =
  /\b(?:run|then|after|before|step|workflow|sequence|pipeline|first|next|finally|build|test|deploy|verify|lint|typecheck)\b/gi;
const CONVENTION_PATTERN =
  /\b(?:always|never|must|should|convention|rule|pattern|prefer|use|avoid|standard|policy|architecture)\b/gi;
const PROCEDURAL_COMMAND_SIGNAL =
  /`[^`]+`|\b(?:npm|pnpm|yarn|bun|node|npx|tsx|tsc|vitest|jest|cargo|go|python|pip|make|docker|kubectl|gh|git|ddudu)\s+[\w./:-]+/i;
const PROCEDURAL_WORKFLOW_SIGNAL =
  /\b(?:run|then|after|before|step|workflow|sequence|pipeline|first|next|finally|build|test|deploy|verify|lint|typecheck)\b/i;
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'before',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'then',
  'to',
  'use',
  'with',
]);

const clamp = (value: number, min = 0, max = 1): number => {
  return Math.min(max, Math.max(min, value));
};

const round = (value: number): number => {
  return Number(value.toFixed(4));
};

const normalizeText = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 $2')
    .replace(/[>*_#~|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const toWordSet = (value: string): Set<string> => {
  const tokens = normalizeText(value)
    .split(/[^a-z0-9./:_-]+/)
    .map((token) => token.trim())
    .map((token) => token.replace(/^(?:the|a|an)-/, ''))
    .map((token) => (token.endsWith('s') && token.length > 4 ? token.slice(0, -1) : token))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  return new Set(tokens);
};

const jaccardSimilarity = (left: Set<string>, right: Set<string>): number => {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }

  const union = left.size + right.size - intersection;
  if (union === 0) {
    return 0;
  }

  return intersection / union;
};

const countPatternMatches = (content: string, pattern: RegExp): number => {
  const matches = content.match(pattern);
  return matches?.length ?? 0;
};

const extractUniqueSentences = (content: string): string[] => {
  const normalized = content
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  return Array.from(new Set(normalized));
};

const estimateSpecificitySignals = (content: string): number => {
  const paths = countPatternMatches(content, PATH_PATTERN);
  const commands = countPatternMatches(content, COMMAND_PATTERN);
  const values = countPatternMatches(content, VALUE_PATTERN);
  return paths * 1.4 + commands * 1.2 + values * 0.5;
};

const hasProceduralSignal = (content: string): boolean => {
  return PROCEDURAL_COMMAND_SIGNAL.test(content) || PROCEDURAL_WORKFLOW_SIGNAL.test(content);
};

const estimateReuseSignals = (content: string): number => {
  const commandCount = countPatternMatches(content, COMMAND_PATTERN);
  const workflowCount = countPatternMatches(content, WORKFLOW_PATTERN);
  const conventionCount = countPatternMatches(content, CONVENTION_PATTERN);

  let score = commandCount * 0.22 + workflowCount * 0.12 + conventionCount * 0.16;
  if (hasProceduralSignal(content)) {
    score += 0.15;
  }
  return score;
};

const estimateStabilitySignals = (
  content: string,
  changedFiles: string[],
  verificationStatus: PromotionCandidate['verificationStatus'],
): number => {
  const pathSignals = countPatternMatches(content, PATH_PATTERN);
  const conventionSignals = countPatternMatches(content, CONVENTION_PATTERN);
  const fileAnchors = changedFiles.length > 0 ? 0.1 + Math.min(0.3, changedFiles.length * 0.05) : 0;
  const verificationBoost = verificationStatus === 'passed' ? 0.28 : verificationStatus === 'skipped' ? 0.1 : 0;
  return pathSignals * 0.1 + conventionSignals * 0.07 + fileAnchors + verificationBoost;
};

const verificationScore = (status: PromotionCandidate['verificationStatus']): number => {
  if (status === 'passed') {
    return 1;
  }
  if (status === 'skipped') {
    return 0.3;
  }
  return 0;
};

export const dedupeAgainstExisting = (
  candidate: string,
  existingEntries: string[],
): { isDuplicate: boolean; overlapRatio: number; matchIndex: number } => {
  const candidateWords = toWordSet(candidate);

  let bestRatio = 0;
  let bestIndex = -1;

  existingEntries.forEach((entry, index) => {
    const ratio = jaccardSimilarity(candidateWords, toWordSet(entry));
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestIndex = index;
    }
  });

  return {
    isDuplicate: bestRatio > 0.7,
    overlapRatio: round(bestRatio),
    matchIndex: bestIndex,
  };
};

export const mergeWithExisting = (candidate: string, existing: string): string => {
  const overlap = jaccardSimilarity(toWordSet(candidate), toWordSet(existing));
  if (overlap < 0.5 || overlap > 0.7) {
    return candidate;
  }

  const candidateSpecificity = estimateSpecificitySignals(candidate);
  const existingSpecificity = estimateSpecificitySignals(existing);
  const primary = candidateSpecificity >= existingSpecificity ? candidate : existing;
  const secondary = primary === candidate ? existing : candidate;

  const primarySentences = extractUniqueSentences(primary);
  const secondarySentences = extractUniqueSentences(secondary);
  const seen = new Set(primarySentences.map((sentence) => normalizeText(sentence)));

  const merged = [...primarySentences];
  for (const sentence of secondarySentences) {
    const normalized = normalizeText(sentence);
    if (!seen.has(normalized)) {
      merged.push(sentence);
      seen.add(normalized);
    }
  }

  return merged.join('\n');
};

export const scoreCandidate = (
  candidate: PromotionCandidate,
  existingMemory: string[],
): PromotionScore => {
  const content = candidate.content.trim();
  const verification = verificationScore(candidate.verificationStatus);

  const stability = clamp(
    0.2 + estimateStabilitySignals(content, candidate.changedFiles, candidate.verificationStatus),
  );
  const reuse = clamp(0.15 + estimateReuseSignals(content));
  const specificity = clamp(0.2 + estimateSpecificitySignals(content) * 0.1);

  const dedupe = dedupeAgainstExisting(content, existingMemory);
  const novelty = clamp(1 - Math.max(0, (dedupe.overlapRatio - 0.6) / 0.4));

  const composite = clamp(
    stability * STABILITY_WEIGHT +
      reuse * REUSE_WEIGHT +
      specificity * SPECIFICITY_WEIGHT +
      verification * VERIFICATION_WEIGHT +
      novelty * NOVELTY_WEIGHT,
  );

  return {
    stability: round(stability),
    reuse: round(reuse),
    specificity: round(specificity),
    verification: round(verification),
    novelty: round(novelty),
    composite: round(composite),
  };
};

export const decidePromotion = (score: PromotionScore): PromotionDecision => {
  if (score.verification < 0.3) {
    return 'keep_working';
  }

  if (score.composite < 0.3) {
    return 'discard';
  }

  if (score.composite >= 0.7 && score.stability >= 0.6 && score.verification >= 0.5) {
    return 'promote_semantic';
  }

  if (score.composite >= 0.6 && score.reuse >= 0.65 && score.specificity >= 0.45) {
    return 'promote_procedural';
  }

  if (score.composite >= 0.4 && score.composite < 0.7) {
    return 'promote_episodic';
  }

  return 'discard';
};

export const shouldReplace = (candidateScore: PromotionScore, existingAge: number): boolean => {
  const clampedAge = Math.max(0, existingAge);
  if (clampedAge <= 7) {
    return false;
  }

  return (
    candidateScore.composite >= 0.65 &&
    candidateScore.stability >= 0.6 &&
    candidateScore.verification >= 0.5
  );
};
