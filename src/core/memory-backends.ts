import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { loadConfigForCwd } from './config.js';
import { getDduduPaths } from './dirs.js';
import type { MemoryEntryMetadata } from './memory-promotion.js';
import type { MemoryScope } from './memory.js';

export interface MemoryBackend {
  readonly name: string;
  loadScopes(cwd: string, scopes: MemoryScope[]): Promise<Array<{ scope: MemoryScope; content: string }>>;
  save(cwd: string, scope: MemoryScope, content: string): Promise<void>;
  append(cwd: string, scope: MemoryScope, entry: string, metadata?: MemoryEntryMetadata): Promise<void>;
  clear(cwd: string, scope: MemoryScope): Promise<void>;
}

type MemoryBackendFactory = () => MemoryBackend;

const PROJECT_MEMORY_FILES: Record<Exclude<MemoryScope, 'global'>, string> = {
  project: 'memory.md',
  working: 'memory/working.md',
  episodic: 'memory/episodic.md',
  semantic: 'memory/semantic.md',
  procedural: 'memory/procedural.md',
};

const getMemoryPath = (cwd: string, scope: MemoryScope): string => {
  const paths = getDduduPaths(cwd);
  if (scope === 'global') {
    return `${paths.globalDir}/memory.md`;
  }

  return `${paths.projectDir}/${PROJECT_MEMORY_FILES[scope]}`;
};

const readMemoryFile = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return '';
    }

    throw error;
  }
};

const ensureMemoryDir = async (filePath: string): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
};

const quoteYamlString = (value: string): string => {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

const formatScoreInline = (score: MemoryEntryMetadata['score']): string => {
  return [
    `stability: ${score.stability}`,
    `reuse: ${score.reuse}`,
    `specificity: ${score.specificity}`,
    `verification: ${score.verification}`,
    `novelty: ${score.novelty}`,
    `composite: ${score.composite}`,
  ].join(', ');
};

const formatMetadataFrontmatter = (metadata: MemoryEntryMetadata): string => {
  const sourceRunIdLine = metadata.sourceRunId
    ? `sourceRunId: ${quoteYamlString(metadata.sourceRunId)}\n`
    : '';

  return [
    '---',
    `confidence: ${metadata.confidence}`,
    `${sourceRunIdLine}promotedAt: ${quoteYamlString(metadata.promotedAt)}`,
    `score: { ${formatScoreInline(metadata.score)} }`,
    '---',
  ].join('\n');
};

class FileMemoryBackend implements MemoryBackend {
  public readonly name = 'file';

  public async loadScopes(
    cwd: string,
    scopes: MemoryScope[],
  ): Promise<Array<{ scope: MemoryScope; content: string }>> {
    return Promise.all(
      scopes.map(async (scope) => ({
        scope,
        content: await readMemoryFile(getMemoryPath(cwd, scope)),
      })),
    );
  }

  public async save(cwd: string, scope: MemoryScope, content: string): Promise<void> {
    const memoryPath = getMemoryPath(cwd, scope);
    await ensureMemoryDir(memoryPath);
    await writeFile(memoryPath, content, 'utf8');
  }

  public async append(
    cwd: string,
    scope: MemoryScope,
    entry: string,
    metadata?: MemoryEntryMetadata,
  ): Promise<void> {
    const memoryPath = getMemoryPath(cwd, scope);
    const timestamp = new Date().toISOString();
    const frontmatter = metadata ? `${formatMetadataFrontmatter(metadata)}\n` : '';
    const formattedEntry = `## Entry — ${timestamp}\n${frontmatter}${entry}\n\n`;

    await ensureMemoryDir(memoryPath);
    await appendFile(memoryPath, formattedEntry, 'utf8');
  }

  public async clear(cwd: string, scope: MemoryScope): Promise<void> {
    const memoryPath = getMemoryPath(cwd, scope);
    await ensureMemoryDir(memoryPath);
    await writeFile(memoryPath, '', 'utf8');
  }
}

const BACKEND_FACTORIES = new Map<string, MemoryBackendFactory>([
  ['file', () => new FileMemoryBackend()],
]);

export const registerMemoryBackend = (name: string, factory: MemoryBackendFactory): void => {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    throw new Error('Memory backend name cannot be empty');
  }
  BACKEND_FACTORIES.set(normalized, factory);
};

export const listMemoryBackends = (): string[] => {
  return Array.from(BACKEND_FACTORIES.keys()).sort();
};

export const resolveMemoryBackendName = async (cwd: string): Promise<string> => {
  const configured = (await loadConfigForCwd(cwd)).memory?.backend?.trim().toLowerCase();
  if (configured && BACKEND_FACTORIES.has(configured)) {
    return configured;
  }
  return 'file';
};

export const getMemoryBackend = async (cwd: string): Promise<MemoryBackend> => {
  const backendName = await resolveMemoryBackendName(cwd);
  const factory = BACKEND_FACTORIES.get(backendName) ?? BACKEND_FACTORIES.get('file');
  if (!factory) {
    throw new Error('No memory backend is available');
  }
  return factory();
};
