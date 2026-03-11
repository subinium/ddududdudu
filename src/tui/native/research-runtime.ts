import type { ToolResult } from '../../tools/index.js';

export interface ResearchShardPlan {
  subject: string;
  label: string;
  query: string;
}

export interface ResearchShardResult {
  subject: string;
  label: string;
  query: string;
  localDocs: string | null;
  webSearch: string | null;
  fetchedSource: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number;
}

export interface ResearchRuntimeInput {
  task: string;
  subjects: string[];
  includeLocalDocs: boolean;
  maxConcurrency?: number;
  runTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  synthesize?: (input: {
    task: string;
    subjects: string[];
    shards: ResearchShardResult[];
  }) => Promise<string>;
}

export interface ResearchRuntimeHandlers {
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  onAgentActivity?: (activity: {
    id: string;
    label: string;
    status: 'queued' | 'running' | 'verifying' | 'done' | 'error';
    purpose?: string;
    detail?: string;
  }) => void;
  onShardComplete?: (result: ResearchShardResult, completed: number, total: number) => void;
}

export interface ResearchRuntimeResult {
  output: string;
  shards: ResearchShardResult[];
}

interface SearchResultCandidate {
  title?: string;
  url?: string;
  snippet?: string | null;
}

const QUERY_NOISE_PATTERN = /\b(?:research|investigate|look into|survey|compare|explore|analyze|parallel|search|please|find|about)\b|(?:리서치|조사|찾아줘|찾아|비교|탐색|분석해|알아봐|병렬|동시에|찾기|해줘)/giu;

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const previewText = (value: string, maxLength: number): string => {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const uniqueValues = (values: string[]): string[] => Array.from(new Set(values));

const buildSubjectQuery = (
  subject: string,
  task: string,
  subjects: string[],
): string => {
  const escapedSubjects = uniqueValues(subjects)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter((value) => value.length > 0);
  const subjectPattern = escapedSubjects.length > 0
    ? new RegExp(`\\b(?:${escapedSubjects.join('|')})\\b`, 'giu')
    : null;
  const stripped = normalizeWhitespace(
    task
      .replace(subjectPattern ?? /$^/u, ' ')
      .replace(/[/:,()]/gu, ' ')
      .replace(QUERY_NOISE_PATTERN, ' '),
  );
  return normalizeWhitespace([subject, stripped].filter(Boolean).join(' '));
};

const readSearchCandidates = (metadata: unknown): SearchResultCandidate[] => {
  if (typeof metadata !== 'object' || metadata === null) {
    return [];
  }

  const candidateList = (metadata as { results?: unknown }).results;
  if (!Array.isArray(candidateList)) {
    return [];
  }

  return candidateList
    .filter((entry): entry is SearchResultCandidate => typeof entry === 'object' && entry !== null)
    .slice(0, 3);
};

const formatShardFallback = (task: string, shards: ResearchShardResult[]): string => {
  const sections = [
    `Research summary for: ${task}`,
    '',
    ...shards.flatMap((shard, index) => {
      const detail = [
        shard.localDocs ? `Local docs:\n${shard.localDocs}` : null,
        shard.webSearch ? `Web search:\n${shard.webSearch}` : null,
        shard.fetchedSource ? `Fetched source:\n${shard.fetchedSource}` : null,
        shard.error ? `Error: ${shard.error}` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n\n');
      return [
        `${index + 1}. ${shard.subject}`,
        detail || 'No evidence collected.',
        '',
      ];
    }),
  ];

  return sections.join('\n').trim();
};

export const formatResearchProgress = (input: {
  task: string;
  completed: number;
  total: number;
  running: string[];
  shards: ResearchShardResult[];
}): string => {
  const lines = [
    `Parallel research · ${input.completed}/${input.total} complete`,
    input.running.length > 0 ? `Running: ${input.running.join(', ')}` : null,
    '',
    `Task: ${input.task}`,
    '',
  ].filter((line): line is string => Boolean(line));

  for (const shard of input.shards) {
    const evidence = shard.error
      ? `error: ${previewText(shard.error, 160)}`
      : shard.fetchedSource
        ? previewText(shard.fetchedSource, 320)
        : shard.webSearch
          ? previewText(shard.webSearch, 320)
          : shard.localDocs
            ? previewText(shard.localDocs, 320)
            : 'No evidence collected yet.';
    lines.push(`- ${shard.subject}: ${evidence}`);
  }

  return lines.join('\n').trim();
};

const poolRun = async <T>(
  items: T[],
  maxConcurrency: number,
  runner: (item: T, index: number) => Promise<void>,
): Promise<void> => {
  if (items.length === 0) {
    return;
  }

  const concurrency = Math.max(1, Math.min(maxConcurrency, items.length));
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await runner(items[index] as T, index);
    }
  });
  await Promise.all(workers);
};

export class ResearchRuntime {
  public async run(
    input: ResearchRuntimeInput,
    handlers: ResearchRuntimeHandlers = {},
  ): Promise<ResearchRuntimeResult> {
    const subjectPlans = input.subjects.map((subject) => ({
      subject,
      label: subject,
      query: buildSubjectQuery(subject, input.task, input.subjects),
    }));
    const results: ResearchShardResult[] = new Array(subjectPlans.length);
    let completed = 0;

    for (const plan of subjectPlans) {
      handlers.onAgentActivity?.({
        id: `research:${plan.subject}`,
        label: plan.label,
        status: 'queued',
        purpose: 'research',
        detail: plan.query,
      });
    }

    await poolRun(
      subjectPlans,
      input.maxConcurrency ?? 4,
      async (plan, index) => {
        if (handlers.signal?.aborted) {
          throw new Error('Research run aborted.');
        }

        const activityId = `research:${plan.subject}`;
        const startedAt = Date.now();
        handlers.onAgentActivity?.({
          id: activityId,
          label: plan.label,
          status: 'running',
          purpose: 'research',
          detail: `searching · ${plan.query}`,
        });
        handlers.onProgress?.(`Researching ${plan.subject}...`);

        try {
          const localDocsPromise = input.includeLocalDocs
            ? input.runTool('docs_lookup', {
                query: plan.query,
                scope: 'all',
                max_results: 4,
              })
            : Promise.resolve<ToolResult>({
                output: '',
              });
          const webSearchPromise = input.runTool('web_search', {
            query: plan.query,
            max_results: 4,
          });

          const [localDocsResult, webSearchResult] = await Promise.all([localDocsPromise, webSearchPromise]);
          let fetchedSource: string | null = null;
          const candidates = readSearchCandidates(webSearchResult.metadata);
          const primaryUrl = candidates.find((entry) => typeof entry.url === 'string' && entry.url.trim().length > 0)?.url ?? null;

          if (primaryUrl) {
            const fetched = await input.runTool('web_fetch', {
              url: primaryUrl,
              extract: 'readable',
              max_bytes: 6 * 1024,
            });
            fetchedSource = fetched.isError ? null : fetched.output;
          }

          const result: ResearchShardResult = {
            subject: plan.subject,
            label: plan.label,
            query: plan.query,
            localDocs: localDocsResult.output.trim() ? localDocsResult.output : null,
            webSearch: webSearchResult.output.trim() ? webSearchResult.output : null,
            fetchedSource,
            error: webSearchResult.isError ? webSearchResult.output : null,
            startedAt,
            finishedAt: Date.now(),
          };
          results[index] = result;
          completed += 1;
          handlers.onAgentActivity?.({
            id: activityId,
            label: plan.label,
            status: result.error ? 'error' : 'done',
            purpose: 'research',
            detail: result.error
              ? previewText(result.error, 120)
              : `done · ${completed}/${subjectPlans.length}`,
          });
          handlers.onShardComplete?.(result, completed, subjectPlans.length);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          const result: ResearchShardResult = {
            subject: plan.subject,
            label: plan.label,
            query: plan.query,
            localDocs: null,
            webSearch: null,
            fetchedSource: null,
            error: message,
            startedAt,
            finishedAt: Date.now(),
          };
          results[index] = result;
          completed += 1;
          handlers.onAgentActivity?.({
            id: activityId,
            label: plan.label,
            status: 'error',
            purpose: 'research',
            detail: previewText(message, 120),
          });
          handlers.onShardComplete?.(result, completed, subjectPlans.length);
        }
      },
    );

    const shards = results.filter((result): result is ResearchShardResult => Boolean(result));
    const output = input.synthesize
      ? await input.synthesize({
          task: input.task,
          subjects: input.subjects,
          shards,
        })
      : formatShardFallback(input.task, shards);

    return {
      output,
      shards,
    };
  }
}
