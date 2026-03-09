import { getMemoryBackend } from './memory-backends.js';

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
  const backend = await getMemoryBackend(cwd);
  return backend.loadScopes(cwd, scopes);
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
  const backend = await getMemoryBackend(cwd);
  await backend.save(cwd, scope, content);
};

export const appendMemory = async (
  cwd: string,
  entry: string,
  scope: MemoryScope,
): Promise<void> => {
  const backend = await getMemoryBackend(cwd);
  await backend.append(cwd, scope, entry);
};

export const clearMemory = async (cwd: string, scope: MemoryScope): Promise<void> => {
  const backend = await getMemoryBackend(cwd);
  await backend.clear(cwd, scope);
};
