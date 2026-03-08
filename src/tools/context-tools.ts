import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Tool } from './index.js';

const execFileAsync = promisify(execFile);

const DEFAULT_EXCLUDES = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const CHANGE_PATTERNS = ['diff', 'status', 'modified', 'changed', 'recent', 'touched'];

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

const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });

  return result.stdout.trim();
};

const getChangedFiles = async (rootPath: string): Promise<string[]> => {
  try {
    const diff = await runGit(rootPath, ['status', '--short']);
    if (!diff) {
      return [];
    }

    return diff
      .split('\n')
      .map((line) => line.replace(/\r/g, ''))
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const match = /^[ MADRCU?!]{1,2}\s+(.+)$/.exec(line);
        return match?.[1]?.trim() ?? line.trim();
      })
      .filter((line) => line.length > 0)
      .map((line) => normalizePath(line.replace(/^.* -> /, '')));
  } catch {
    return [];
  }
};

const buildReferencePattern = (query: string): RegExp => {
  const escaped = escapeRegExp(query.trim());
  if (/^[a-z_][a-z0-9_]*$/i.test(query.trim())) {
    return new RegExp(`\\b${escaped}\\b`);
  }

  return new RegExp(escaped);
};

const isDefinitionLine = (query: string, line: string): boolean => {
  return SYMBOL_PATTERNS(query).some((pattern) => pattern.test(line));
};

const changedFileBoost = (queryTokens: string[], relPath: string, changedFiles: Set<string>): number => {
  let score = 0;
  if (changedFiles.has(relPath)) {
    score += 6;
  }

  const lowerPath = relPath.toLowerCase();
  for (const token of queryTokens) {
    if (lowerPath.includes(token)) {
      score += 2;
    }
  }

  if (CHANGE_PATTERNS.some((token) => queryTokens.includes(token)) && changedFiles.has(relPath)) {
    score += 12;
  }

  return score;
};

const renderGroupedMatches = (
  matches: Array<{ path: string; line: string; score: number }>,
  maxFiles: number,
  maxLinesPerFile: number,
): string => {
  const grouped = new Map<string, { score: number; lines: string[] }>();

  for (const match of matches) {
    const current = grouped.get(match.path);
    if (current) {
      current.score += match.score;
      if (current.lines.length < maxLinesPerFile) {
        current.lines.push(match.line);
      }
      continue;
    }

    grouped.set(match.path, {
      score: match.score,
      lines: [match.line],
    });
  }

  return Array.from(grouped.entries())
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .slice(0, maxFiles)
    .map(([path, group]) => {
      return [
        `# ${path} (score ${group.score})`,
        ...group.lines,
      ].join('\n');
    })
    .join('\n\n');
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

export const referenceSearchTool: Tool = {
  definition: {
    name: 'reference_search',
    description: 'Search for cross-file references and usages of a symbol or identifier.',
    parameters: {
      query: { type: 'string', description: 'Identifier or symbol reference to search for.', required: true },
      path: { type: 'string', description: 'Base path for searching.' },
      max_results: { type: 'number', description: 'Maximum lines to return.' },
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
        : 80;

    try {
      const files = await walkFiles(rootPath, DEFAULT_EXCLUDES);
      const pattern = buildReferencePattern(args.query);
      const changedFiles = new Set(await getChangedFiles(rootPath));
      const scored: Array<{ score: number; line: string }> = [];

      for (const filePath of files) {
        const text = await readTextFile(filePath);
        if (!text) {
          continue;
        }

        const relPath = normalizePath(relative(rootPath, filePath));
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (!pattern.test(line)) {
            continue;
          }

          let score = changedFiles.has(relPath) ? 4 : 0;
          if (!isDefinitionLine(args.query, line)) {
            score += 3;
          }
          if (line.includes(args.query.trim())) {
            score += 1;
          }

          scored.push({
            score,
            line: `${relPath}:${index + 1}: ${line.trim()}`,
          });
        }
      }

      scored.sort((a, b) => b.score - a.score || a.line.localeCompare(b.line));
      const output = scored.slice(0, maxResults).map((entry) => entry.line).join('\n');

      return {
        output,
        metadata: {
          root: rootPath,
          count: Math.min(scored.length, maxResults),
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

export const definitionSearchTool: Tool = {
  definition: {
    name: 'definition_search',
    description: 'Find likely symbol definitions with exact identifier and changed-file bias.',
    parameters: {
      query: { type: 'string', description: 'Identifier or symbol name to resolve.', required: true },
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
        : 8;

    try {
      const files = await walkFiles(rootPath, DEFAULT_EXCLUDES);
      const patterns = SYMBOL_PATTERNS(args.query.trim());
      const changedFiles = new Set(await getChangedFiles(rootPath));
      const matches: Array<{ path: string; line: string; score: number }> = [];

      for (const filePath of files) {
        const text = await readTextFile(filePath);
        if (!text) {
          continue;
        }

        const relPath = normalizePath(relative(rootPath, filePath));
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (!patterns.some((pattern) => pattern.test(line))) {
            continue;
          }

          let score = changedFiles.has(relPath) ? 8 : 3;
          if (line.includes(args.query.trim())) {
            score += 3;
          }
          if (relPath.toLowerCase().includes(args.query.trim().toLowerCase())) {
            score += 2;
          }

          matches.push({
            path: relPath,
            line: `${relPath}:${index + 1}: ${line.trim()}`,
            score,
          });
        }
      }

      const output = renderGroupedMatches(matches, maxResults, 3);
      return {
        output,
        metadata: {
          root: rootPath,
          count: Math.min(new Set(matches.map((match) => match.path)).size, maxResults),
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

export const referenceHotspotsTool: Tool = {
  definition: {
    name: 'reference_hotspots',
    description: 'Aggregate reference hits by file to find the most relevant implementation hotspots.',
    parameters: {
      query: { type: 'string', description: 'Identifier or symbol reference to search for.', required: true },
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
        : 8;

    try {
      const files = await walkFiles(rootPath, DEFAULT_EXCLUDES);
      const pattern = buildReferencePattern(args.query);
      const changedFiles = new Set(await getChangedFiles(rootPath));
      const matches: Array<{ path: string; line: string; score: number }> = [];

      for (const filePath of files) {
        const text = await readTextFile(filePath);
        if (!text) {
          continue;
        }

        const relPath = normalizePath(relative(rootPath, filePath));
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (!pattern.test(line) || isDefinitionLine(args.query, line)) {
            continue;
          }

          let score = changedFiles.has(relPath) ? 5 : 2;
          if (line.includes(args.query.trim())) {
            score += 1;
          }

          matches.push({
            path: relPath,
            line: `${relPath}:${index + 1}: ${line.trim()}`,
            score,
          });
        }
      }

      const output = renderGroupedMatches(matches, maxResults, 3);
      return {
        output,
        metadata: {
          root: rootPath,
          count: Math.min(new Set(matches.map((match) => match.path)).size, maxResults),
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

export const changedFilesTool: Tool = {
  definition: {
    name: 'changed_files',
    description: 'List changed files in the current git worktree to bias retrieval toward active edits.',
    parameters: {
      path: { type: 'string', description: 'Base path for the git worktree.' },
    },
  },
  async execute(args, ctx) {
    const rootPath =
      typeof args.path === 'string' && args.path.trim().length > 0
        ? resolve(ctx.cwd, args.path)
        : ctx.cwd;

    try {
      const changedFiles = await getChangedFiles(rootPath);
      return {
        output: changedFiles.join('\n'),
        metadata: {
          root: rootPath,
          count: changedFiles.length,
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
      const changedFiles = new Set(await getChangedFiles(rootPath));
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
        let score = changedFileBoost(tokens, relPath, changedFiles);

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
          const changed = changedFiles.has(entry.path) ? ' · changed' : '';
          return [
            `# ${entry.path} (score ${entry.score}${changed})`,
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
          changedFiles: Array.from(changedFiles.values()),
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
