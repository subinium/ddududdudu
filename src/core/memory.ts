import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getDduduPaths } from './dirs.js';

export type MemoryScope = 'global' | 'project';

const MEMORY_FILE_NAME = 'memory.md';

const getMemoryPath = (cwd: string, scope: MemoryScope): string => {
  const paths = getDduduPaths(cwd);
  const baseDir = scope === 'global' ? paths.globalDir : paths.projectDir;
  return `${baseDir}/${MEMORY_FILE_NAME}`;
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
  const globalPath = getMemoryPath(cwd, 'global');
  const projectPath = getMemoryPath(cwd, 'project');

  const [globalMemory, projectMemory] = await Promise.all([
    readMemoryFile(globalPath),
    readMemoryFile(projectPath),
  ]);

  return `## Global Memory\n${globalMemory}\n\n## Project Memory\n${projectMemory}`;
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
