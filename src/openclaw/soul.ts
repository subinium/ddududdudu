import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const defaultSoulSearchPaths = (): string[] => {
  return [
    join(process.cwd(), '.ddudu', 'SOUL.md'),
    join(homedir(), '.ddudu', 'SOUL.md'),
    join(process.cwd(), 'SOUL.md'),
  ];
};

export const loadSoul = async (searchPaths?: string[]): Promise<string | null> => {
  const candidates = searchPaths && searchPaths.length > 0 ? searchPaths : defaultSoulSearchPaths();

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, 'utf8');
      if (content.trim().length > 0) {
        return content;
      }
    } catch {
      continue;
    }
  }

  return null;
};
