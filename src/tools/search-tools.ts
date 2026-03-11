import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

import type { Tool } from './index.js';

const DEFAULT_EXCLUDES = new Set(['.git', 'node_modules']);

const isTextFile = (buffer: Buffer): boolean => {
  const length = Math.min(512, buffer.length);
  for (let index = 0; index < length; index += 1) {
    if (buffer[index] === 0) {
      return false;
    }
  }

  return true;
};

const normalizePath = (input: string): string => {
  return input.replace(/\\/g, '/');
};

const globToRegExp = (pattern: string): RegExp => {
  let output = '^';
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];

    if (char === '*') {
      if (pattern[index + 1] === '*') {
        const next = pattern[index + 2];
        if (next === '/') {
          output += '(?:.*/)?';
          index += 3;
          continue;
        }

        output += '.*';
        index += 2;
        continue;
      }

      output += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      output += '[^/]';
      index += 1;
      continue;
    }

    if ('\\.^$+{}()|[]'.includes(char)) {
      output += `\\${char}`;
    } else {
      output += char;
    }
    index += 1;
  }

  output += '$';
  return new RegExp(output);
};

const walkFiles = async (
  rootPath: string,
  excludes: Set<string>,
): Promise<string[]> => {
  const files: string[] = [];

  const walk = async (dirPath: string): Promise<void> => {
    const entries = await readdir(dirPath, { withFileTypes: true });

    await Promise.all(
      entries.map(async (entry) => {
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
  return files;
};

export const globTool: Tool = {
  definition: {
    name: 'glob',
    description: 'Find files by glob pattern.',
    parameters: {
      pattern: { type: 'string', description: 'Glob pattern to match.', required: true },
      path: { type: 'string', description: 'Base path for searching.' },
      exclude: {
        type: 'array',
        description: 'Directory names to exclude.',
        items: { type: 'string', description: 'Directory name to skip.' },
      },
    },
  },
  async execute(args, ctx) {
    if (typeof args.pattern !== 'string' || args.pattern.trim().length === 0) {
      return { output: 'Missing required argument: pattern', isError: true };
    }

    const searchRoot =
      typeof args.path === 'string' && args.path.trim().length > 0
        ? resolve(ctx.cwd, args.path)
        : ctx.cwd;
    const excludes = new Set(DEFAULT_EXCLUDES);

    if (Array.isArray(args.exclude)) {
      for (const item of args.exclude) {
        if (typeof item === 'string' && item.trim().length > 0) {
          excludes.add(item);
        }
      }
    }

    try {
      const allFiles = await walkFiles(searchRoot, excludes);
      const matcher = globToRegExp(normalizePath(args.pattern));
      const matches = allFiles
        .map((fullPath) => normalizePath(relative(searchRoot, fullPath)))
        .filter((relPath) => matcher.test(relPath));

      return {
        output: matches.join('\n'),
        metadata: {
          root: searchRoot,
          count: matches.length,
        },
      };
    } catch (err: unknown) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};

export const grepTool: Tool = {
  definition: {
    name: 'grep',
    description:
      'Search file contents for exact text or regex patterns. Use this when you know the specific string, identifier, or pattern to find. ' +
      'Returns matching lines with file paths and line numbers. ' +
      'For broad natural-language queries where you do not know the exact text, use codebase_search instead.',
    parameters: {
      pattern: { type: 'string', description: 'Regular expression pattern.', required: true },
      path: { type: 'string', description: 'Base path for searching.' },
      include: { type: 'string', description: 'Glob pattern for files.' },
      max_results: { type: 'number', description: 'Maximum matched lines to return.' },
    },
  },
  async execute(args, ctx) {
    if (typeof args.pattern !== 'string' || args.pattern.trim().length === 0) {
      return { output: 'Missing required argument: pattern', isError: true };
    }

    const searchRoot =
      typeof args.path === 'string' && args.path.trim().length > 0
        ? resolve(ctx.cwd, args.path)
        : ctx.cwd;
    const includePattern =
      typeof args.include === 'string' && args.include.trim().length > 0 ? args.include : '**/*';
    const maxResults =
      typeof args.max_results === 'number' && Number.isFinite(args.max_results)
        ? Math.max(1, Math.floor(args.max_results))
        : 100;

    let regex: RegExp;
    let includeRegex: RegExp;

    try {
      regex = new RegExp(args.pattern);
    } catch (err: unknown) {
      return {
        output: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    try {
      includeRegex = globToRegExp(normalizePath(includePattern));
    } catch (err: unknown) {
      return {
        output: `Invalid include pattern: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    try {
      const files = await walkFiles(searchRoot, DEFAULT_EXCLUDES);
      const results: string[] = [];

      for (const filePath of files) {
        if (results.length >= maxResults) {
          break;
        }

        const relPath = normalizePath(relative(searchRoot, filePath));
        if (!includeRegex.test(relPath)) {
          continue;
        }

        const buffer = await readFile(filePath);
        if (!isTextFile(buffer)) {
          continue;
        }

        const lines = buffer.toString('utf8').split('\n');
        for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
          if (results.length >= maxResults) {
            break;
          }

          const line = lines[lineNumber];
          regex.lastIndex = 0;
          if (regex.test(line)) {
            results.push(`${relPath}:${lineNumber + 1}: ${line}`);
          }
        }
      }

      return {
        output: results.join('\n'),
        metadata: {
          root: searchRoot,
          count: results.length,
          maxResults,
        },
      };
    } catch (err: unknown) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
