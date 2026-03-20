import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const WALK_TTL_MS = 2_500;
const TEXT_TTL_MS = 2_500;
const DEFAULT_TEXT_PROBE_BYTES = 512;

interface TimedEntry<T> {
  value: T;
  expiresAt: number;
}

interface TextFileEntry {
  mtimeMs: number;
  text: string | null;
}

const walkCache = new Map<string, TimedEntry<string[]>>();
const textCache = new Map<string, TimedEntry<TextFileEntry>>();

const cacheKeyForWalk = (rootPath: string, excludes: Set<string>): string => {
  return `${rootPath}::${Array.from(excludes).sort().join(',')}`;
};

export const isTextFileBuffer = (buffer: Buffer): boolean => {
  const length = Math.min(DEFAULT_TEXT_PROBE_BYTES, buffer.length);
  for (let index = 0; index < length; index += 1) {
    if (buffer[index] === 0) {
      return false;
    }
  }
  return true;
};

export const walkFilesCached = async (rootPath: string, excludes: Set<string>): Promise<string[]> => {
  const key = cacheKeyForWalk(rootPath, excludes);
  const now = Date.now();
  const cached = walkCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const files: string[] = [];
  const walk = async (dirPath: string): Promise<void> => {
    const entries = await readdir(dirPath, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry: { name: string; isDirectory: () => boolean; isFile: () => boolean }) => {
        if (excludes.has(entry.name)) {
          return;
        }
        const fullPath = resolve(dirPath, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          return;
        }
        if (entry.isFile()) {
          files.push(fullPath);
        }
      }),
    );
  };

  await walk(rootPath);
  files.sort((a, b) => a.localeCompare(b));
  walkCache.set(key, { value: files, expiresAt: now + WALK_TTL_MS });
  return files;
};

export const readTextFileCached = async (filePath: string): Promise<string | null> => {
  const now = Date.now();
  const fileStat = await stat(filePath);
  const cached = textCache.get(filePath);
  if (cached && cached.expiresAt > now && cached.value.mtimeMs === fileStat.mtimeMs) {
    return cached.value.text;
  }

  const buffer = await readFile(filePath);
  const text = isTextFileBuffer(buffer) ? buffer.toString('utf8') : null;
  textCache.set(filePath, {
    value: { mtimeMs: fileStat.mtimeMs, text },
    expiresAt: now + TEXT_TTL_MS,
  });
  return text;
};

export const parallelMapLimit = async <T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(normalizedLimit, items.length) }, () => worker()));
  return results;
};
