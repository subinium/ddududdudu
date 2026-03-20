import { execFile } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Tool } from './index.js';
import { parallelMapLimit, readTextFileCached, walkFilesCached } from './search-cache.js';

const execFileAsync = promisify(execFile);

const DEFAULT_EXCLUDES = new Set(['.git', 'node_modules']);

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
      typeof args.path === 'string' && args.path.trim().length > 0 ? resolve(ctx.cwd, args.path) : ctx.cwd;
    const excludes = new Set(DEFAULT_EXCLUDES);

    if (Array.isArray(args.exclude)) {
      for (const item of args.exclude) {
        if (typeof item === 'string' && item.trim().length > 0) {
          excludes.add(item);
        }
      }
    }

    try {
      const allFiles = await walkFilesCached(searchRoot, excludes);
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
      typeof args.path === 'string' && args.path.trim().length > 0 ? resolve(ctx.cwd, args.path) : ctx.cwd;
    const includePattern = typeof args.include === 'string' && args.include.trim().length > 0 ? args.include : '**/*';
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
      try {
        const argsList = ['--line-number', '--no-heading', '--color=never', '--max-count', String(maxResults)];
        if (includePattern && includePattern !== '**/*') {
          argsList.push('--glob', includePattern);
        }
        argsList.push(args.pattern, searchRoot);
        const rg = await execFileAsync('rg', argsList, {
          cwd: searchRoot,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
        });
        const rgLines = rg.stdout
          .split('\n')
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0)
          .slice(0, maxResults);
        return {
          output: rgLines.join('\n'),
          metadata: {
            root: searchRoot,
            count: rgLines.length,
            maxResults,
            engine: 'rg',
          },
        };
      } catch {
        // Fall back to in-process search when ripgrep is unavailable or errors.
      }

      const files = await walkFilesCached(searchRoot, DEFAULT_EXCLUDES);
      const matchedByFile = await parallelMapLimit(files, 12, async (filePath) => {
        const relPath = normalizePath(relative(searchRoot, filePath));
        if (!includeRegex.test(relPath)) {
          return [] as string[];
        }

        const text = await readTextFileCached(filePath);
        if (!text) {
          return [] as string[];
        }

        const lines = text.split('\n');
        const localResults: string[] = [];
        for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
          if (localResults.length >= maxResults) {
            break;
          }
          const line = lines[lineNumber];
          regex.lastIndex = 0;
          if (regex.test(line)) {
            localResults.push(`${relPath}:${lineNumber + 1}: ${line}`);
          }
        }
        return localResults;
      });
      const results = matchedByFile.flat().slice(0, maxResults);

      return {
        output: results.join('\n'),
        metadata: {
          root: searchRoot,
          count: results.length,
          maxResults,
          engine: 'internal',
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
