import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import type { Tool } from './index.js';

const DEFAULT_EXCLUDES = new Set(['.git', 'node_modules', 'dist', 'coverage']);

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

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const walkFiles = async (
  rootPath: string,
  excludes: Set<string>,
): Promise<string[]> => {
  const files: string[] = [];

  const walk = async (dirPath: string): Promise<void> => {
    const entries = await readdir(dirPath, { withFileTypes: true });

    await Promise.all(entries.map(async (entry) => {
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
    }));
  };

  await walk(rootPath);
  files.sort((a, b) => a.localeCompare(b));
  return files;
};

const tokenizeQuery = (value: string): string[] => {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  );
};

const readTextFile = async (filePath: string): Promise<string | null> => {
  const buffer = await readFile(filePath);
  if (!isTextFile(buffer)) {
    return null;
  }

  return buffer.toString('utf8');
};

const SYMBOL_PATTERNS = (query: string): RegExp[] => {
  const name = escapeRegExp(query);
  return [
    new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`),
    new RegExp(`\\bclass\\s+${name}\\b`),
    new RegExp(`\\binterface\\s+${name}\\b`),
    new RegExp(`\\btype\\s+${name}\\b`),
    new RegExp(`\\benum\\s+${name}\\b`),
    new RegExp(`\\bdef\\s+${name}\\b`),
    new RegExp(`\\bfn\\s+${name}\\b`),
    new RegExp(`\\bstruct\\s+${name}\\b`),
    new RegExp(`\\btrait\\s+${name}\\b`),
  ];
};

const renderTree = async (
  rootPath: string,
  maxDepth: number,
  maxEntries: number,
): Promise<string[]> => {
  const lines: string[] = [];
  let emitted = 0;

  const visit = async (dirPath: string, depth: number): Promise<void> => {
    if (depth > maxDepth || emitted >= maxEntries) {
      return;
    }

    const entries = await readdir(dirPath, { withFileTypes: true });
    const filtered = entries
      .filter((entry) => !DEFAULT_EXCLUDES.has(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) {
          return -1;
        }
        if (!a.isDirectory() && b.isDirectory()) {
          return 1;
        }
        return a.name.localeCompare(b.name);
      });

    for (const entry of filtered) {
      if (emitted >= maxEntries) {
        return;
      }

      const relPath = normalizePath(relative(rootPath, resolve(dirPath, entry.name))) || '.';
      lines.push(`${'  '.repeat(depth)}${entry.isDirectory() ? '▸' : '•'} ${relPath}`);
      emitted += 1;

      if (entry.isDirectory()) {
        await visit(resolve(dirPath, entry.name), depth + 1);
      }
    }
  };

  await visit(rootPath, 0);
  return lines;
};

export const repoMapTool: Tool = {
  definition: {
    name: 'repo_map',
    description: 'Render a compact tree of the repository to understand structure quickly.',
    parameters: {
      path: { type: 'string', description: 'Base path for the repo map.' },
      max_depth: { type: 'number', description: 'Maximum directory depth to include.' },
      max_entries: { type: 'number', description: 'Maximum number of lines to return.' },
    },
  },
  async execute(args, ctx) {
    const rootPath =
      typeof args.path === 'string' && args.path.trim().length > 0
        ? resolve(ctx.cwd, args.path)
        : ctx.cwd;
    const maxDepth =
      typeof args.max_depth === 'number' && Number.isFinite(args.max_depth)
        ? Math.max(1, Math.floor(args.max_depth))
        : 3;
    const maxEntries =
      typeof args.max_entries === 'number' && Number.isFinite(args.max_entries)
        ? Math.max(20, Math.floor(args.max_entries))
        : 160;

    try {
      const lines = await renderTree(rootPath, maxDepth, maxEntries);
      return {
        output: lines.join('\n'),
        metadata: {
          root: rootPath,
          maxDepth,
          maxEntries,
        },
      };
    } catch (error: unknown) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  },
};

export const symbolSearchTool: Tool = {
  definition: {
    name: 'symbol_search',
    description: 'Search likely symbol definitions such as functions, classes, interfaces, and structs.',
    parameters: {
      query: { type: 'string', description: 'Symbol name or partial name to search for.', required: true },
      path: { type: 'string', description: 'Base path for searching.' },
      max_results: { type: 'number', description: 'Maximum results to return.' },
    },
  },
  async execute(args, ctx) {
    if (typeof args.query !== 'string' || args.query.trim().length === 0) {
      return { output: 'Missing required argument: query', isError: true };
    }

    const rootPath =
      typeof args.path === 'string' && args.path.trim().length > 0
        ? resolve(ctx.cwd, args.path)
        : ctx.cwd;
    const maxResults =
      typeof args.max_results === 'number' && Number.isFinite(args.max_results)
        ? Math.max(1, Math.floor(args.max_results))
        : 60;

    try {
      const files = await walkFiles(rootPath, DEFAULT_EXCLUDES);
      const patterns = SYMBOL_PATTERNS(args.query.trim());
      const results: string[] = [];

      for (const filePath of files) {
        if (results.length >= maxResults) {
          break;
        }

        const text = await readTextFile(filePath);
        if (!text) {
          continue;
        }

        const relPath = normalizePath(relative(rootPath, filePath));
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          if (results.length >= maxResults) {
            break;
          }

          const line = lines[index];
          if (patterns.some((pattern) => pattern.test(line))) {
            results.push(`${relPath}:${index + 1}: ${line.trim()}`);
          }
        }
      }

      return {
        output: results.join('\n'),
        metadata: {
          root: rootPath,
          count: results.length,
        },
      };
    } catch (error: unknown) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  },
};

export const codebaseSearchTool: Tool = {
  definition: {
    name: 'codebase_search',
    description: 'Search the codebase semantically by scoring files and lines against a natural-language query.',
    parameters: {
      query: { type: 'string', description: 'Natural-language query or keywords.', required: true },
      path: { type: 'string', description: 'Base path for searching.' },
      max_results: { type: 'number', description: 'Maximum files to return.' },
    },
  },
  async execute(args, ctx) {
    if (typeof args.query !== 'string' || args.query.trim().length === 0) {
      return { output: 'Missing required argument: query', isError: true };
    }

    const rootPath =
      typeof args.path === 'string' && args.path.trim().length > 0
        ? resolve(ctx.cwd, args.path)
        : ctx.cwd;
    const maxResults =
      typeof args.max_results === 'number' && Number.isFinite(args.max_results)
        ? Math.max(1, Math.floor(args.max_results))
        : 12;
    const tokens = tokenizeQuery(args.query);

    if (tokens.length === 0) {
      return { output: 'Query did not contain enough searchable tokens.', isError: true };
    }

    try {
      const files = await walkFiles(rootPath, DEFAULT_EXCLUDES);
      const scored: Array<{ path: string; score: number; lines: string[] }> = [];

      for (const filePath of files) {
        const relPath = normalizePath(relative(rootPath, filePath));
        const text = await readTextFile(filePath);
        if (!text) {
          continue;
        }

        const lowerPath = relPath.toLowerCase();
        const lines = text.split('\n');
        const matches: string[] = [];
        let score = 0;

        for (const token of tokens) {
          if (lowerPath.includes(token)) {
            score += 3;
          }
        }

        for (let index = 0; index < lines.length; index += 1) {
          const lowerLine = lines[index].toLowerCase();
          let lineScore = 0;
          for (const token of tokens) {
            if (lowerLine.includes(token)) {
              lineScore += 1;
            }
          }

          if (lineScore > 0) {
            score += lineScore;
            if (matches.length < 4) {
              matches.push(`${relPath}:${index + 1}: ${lines[index].trim()}`);
            }
          }
        }

        if (score > 0) {
          scored.push({ path: relPath, score, lines: matches });
        }
      }

      scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      const top = scored.slice(0, maxResults);
      const output = top
        .map((entry) => {
          return [
            `# ${entry.path} (score ${entry.score})`,
            ...entry.lines,
          ].join('\n');
        })
        .join('\n\n');

      return {
        output,
        metadata: {
          root: rootPath,
          tokens,
          count: top.length,
        },
      };
    } catch (error: unknown) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  },
};

