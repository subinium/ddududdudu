import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getDduduPaths } from './dirs.js';

export type MemoryScope =
  | 'global'
  | 'project'
  | 'working'
  | 'episodic'
  | 'semantic'
  | 'procedural';

const ALL_MEMORY_SCOPES: MemoryScope[] = [
  'global',
  'project',
  'working',
  'episodic',
  'semantic',
  'procedural',
];

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

export const loadMemory = async (cwd: string): Promise<string> => {
  const contents = await loadMemoryScopes(cwd);

  return contents
    .map(({ scope, content }) => {
      const title = scope.charAt(0).toUpperCase() + scope.slice(1);
      return `## ${title} Memory\n${content}`;
    })
    .join('\n\n');
};

export const loadMemoryScopes = async (
  cwd: string,
  scopes: MemoryScope[] = ALL_MEMORY_SCOPES,
): Promise<Array<{ scope: MemoryScope; content: string }>> => {
  return Promise.all(
    scopes.map(async (scope) => ({
      scope,
      content: await readMemoryFile(getMemoryPath(cwd, scope)),
    })),
  );
};

const clipMemory = (value: string, maxChars: number): string => {
  const normalized = value.trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
};

export const loadSelectedMemory = async (
  cwd: string,
  scopes: MemoryScope[],
  maxCharsPerScope: number = 500,
): Promise<string> => {
  const contents = await loadMemoryScopes(cwd, scopes);

  return contents
    .map(({ scope, content }) => {
      const clipped = clipMemory(content, maxCharsPerScope);
      if (!clipped) {
        return '';
      }
      const title = scope.charAt(0).toUpperCase() + scope.slice(1);
      return `## ${title} Memory\n${clipped}`;
    })
    .filter((entry) => entry.length > 0)
    .join('\n\n');
};

export const saveMemory = async (
  cwd: string,
  content: string,
  scope: MemoryScope,
): Promise<void> => {
  const memoryPath = getMemoryPath(cwd, scope);
  await ensureMemoryDir(memoryPath);
  await writeFile(memoryPath, content, 'utf8');
};

export const appendMemory = async (
  cwd: string,
  entry: string,
  scope: MemoryScope,
): Promise<void> => {
  const memoryPath = getMemoryPath(cwd, scope);
  const timestamp = new Date().toISOString();
  const formattedEntry = `## Entry — ${timestamp}\n${entry}\n\n`;

  await ensureMemoryDir(memoryPath);
  await appendFile(memoryPath, formattedEntry, 'utf8');
};

export const clearMemory = async (cwd: string, scope: MemoryScope): Promise<void> => {
  const memoryPath = getMemoryPath(cwd, scope);
  await ensureMemoryDir(memoryPath);
  await writeFile(memoryPath, '', 'utf8');
};
