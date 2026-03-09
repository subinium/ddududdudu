import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';

import { getDduduPaths } from '../core/dirs.js';
import type { Tool } from './index.js';

const DEFAULT_EXCLUDES = new Set(['.git', 'node_modules', 'dist', 'coverage', 'tmp', 'target']);
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.yaml', '.yml', '.json']);
const MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_RESULTS = 8;

interface DocCandidate {
  path: string;
  source: 'repo' | 'instructions' | 'docs';
  label: string;
}

interface DocMatch {
  path: string;
  source: DocCandidate['source'];
  score: number;
  line: number;
  preview: string;
}

const normalizePath = (value: string): string => value.replace(/\\/g, '/');

const preview = (value: string, maxLength: number = 220): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const isDocLike = (filePath: string): boolean => {
  const name = basename(filePath).toLowerCase();
  if (
    name === 'readme' ||
    name.startsWith('readme.') ||
    name.startsWith('contributing') ||
    name.startsWith('changelog') ||
    name === 'agents.md'
  ) {
    return true;
  }

  return DOC_EXTENSIONS.has(extname(name));
};

const walkFiles = async (rootPath: string, excludes: Set<string>): Promise<string[]> => {
  const files: string[] = [];

  const walk = async (dirPath: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

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
  files.sort((left, right) => left.localeCompare(right));
  return files;
};

const scoreLine = (queryTerms: string[], relPath: string, line: string, source: DocCandidate['source']): number => {
  const normalizedLine = line.toLowerCase();
  const normalizedPath = relPath.toLowerCase();
  let score = 0;
  let matched = false;

  for (const term of queryTerms) {
    if (normalizedLine.includes(term)) {
      score += 6;
      matched = true;
    }
    if (normalizedPath.includes(term)) {
      score += 3;
      matched = true;
    }
  }

  if (!matched) {
    return 0;
  }

  if (source === 'instructions') {
    score += 2;
  } else if (source === 'docs') {
    score += 1;
  }

  return score;
};

export const collectDocsCandidates = async (
  cwd: string,
  scope: 'auto' | 'repo' | 'instructions' | 'docs' | 'all',
): Promise<DocCandidate[]> => {
  const paths = getDduduPaths(cwd);
  const candidates: DocCandidate[] = [];

  const pushFile = (filePath: string, source: DocCandidate['source'], label: string): void => {
    candidates.push({
      path: filePath,
      source,
      label,
    });
  };

  if (scope === 'auto' || scope === 'instructions' || scope === 'all') {
    pushFile(paths.projectInstructions, 'instructions', '.ddudu/DDUDU.md');
    pushFile(paths.globalInstructions, 'instructions', '~/.ddudu/DDUDU.md');
    const projectRules = await walkFiles(paths.projectRules, DEFAULT_EXCLUDES);
    for (const filePath of projectRules) {
      if (isDocLike(filePath)) {
        pushFile(filePath, 'instructions', normalizePath(relative(cwd, filePath)));
      }
    }
    const globalRules = await walkFiles(paths.globalRules, DEFAULT_EXCLUDES);
    for (const filePath of globalRules) {
      if (isDocLike(filePath)) {
        pushFile(filePath, 'instructions', normalizePath(filePath.replace(paths.globalDir, '~/.ddudu')));
      }
    }
    const projectPrompts = await walkFiles(paths.projectPrompts, DEFAULT_EXCLUDES);
    for (const filePath of projectPrompts) {
      if (isDocLike(filePath)) {
        pushFile(filePath, 'instructions', normalizePath(relative(cwd, filePath)));
      }
    }
  }

  if (scope === 'auto' || scope === 'repo' || scope === 'all') {
    const repoFiles = [
      resolve(cwd, 'README.md'),
      resolve(cwd, 'AGENTS.md'),
      resolve(cwd, 'CONTRIBUTING.md'),
      resolve(cwd, 'CHANGELOG.md'),
    ];
    for (const filePath of repoFiles) {
      pushFile(filePath, 'repo', normalizePath(relative(cwd, filePath)));
    }
  }

  if (scope === 'auto' || scope === 'docs' || scope === 'all' || scope === 'repo') {
    for (const dirName of ['docs', 'doc']) {
      const files = await walkFiles(resolve(cwd, dirName), DEFAULT_EXCLUDES);
      for (const filePath of files) {
        if (isDocLike(filePath)) {
          pushFile(filePath, 'docs', normalizePath(relative(cwd, filePath)));
        }
      }
    }
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) {
      return false;
    }
    seen.add(candidate.path);
    return true;
  });
};

export const searchDocs = async (
  cwd: string,
  query: string,
  scope: 'auto' | 'repo' | 'instructions' | 'docs' | 'all',
  maxResults: number,
): Promise<DocMatch[]> => {
  const normalizedQuery = query.trim().toLowerCase();
  const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
  const candidates = await collectDocsCandidates(cwd, scope);
  const matches: DocMatch[] = [];

  for (const candidate of candidates) {
    let content: string;
    try {
      const raw = await readFile(candidate.path);
      if (raw.byteLength > MAX_FILE_BYTES) {
        continue;
      }
      content = raw.toString('utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const score = scoreLine(queryTerms, candidate.label, line, candidate.source);
      if (score <= 0) {
        continue;
      }

      matches.push({
        path: candidate.label,
        source: candidate.source,
        score,
        line: index + 1,
        preview: preview(line, 180),
      });
    }
  }

  return matches
    .sort((left, right) =>
      right.score - left.score
      || left.path.localeCompare(right.path)
      || left.line - right.line)
    .slice(0, maxResults);
};

export const docsLookupTool: Tool = {
  definition: {
    name: 'docs_lookup',
    description: 'Search repository docs, instructions, and local knowledge files before falling back to the web.',
    parameters: {
      query: { type: 'string', description: 'What to look up in local docs.', required: true },
      scope: {
        type: 'string',
        description: 'Where to search first.',
        enum: ['auto', 'repo', 'instructions', 'docs', 'all'],
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of local doc matches to return.',
      },
    },
  },
  async execute(args, ctx) {
    if (typeof args.query !== 'string' || args.query.trim().length === 0) {
      return { output: 'Missing required argument: query', isError: true };
    }

    const scope =
      args.scope === 'repo' || args.scope === 'instructions' || args.scope === 'docs' || args.scope === 'all'
        ? args.scope
        : 'auto';
    const maxResults =
      typeof args.max_results === 'number' && Number.isFinite(args.max_results)
        ? Math.max(1, Math.min(12, Math.floor(args.max_results)))
        : DEFAULT_MAX_RESULTS;

    const matches = await searchDocs(ctx.cwd, args.query, scope, maxResults);
    if (matches.length === 0) {
      return {
        output: `No local documentation matches found for "${args.query.trim()}".`,
        metadata: {
          query: args.query.trim(),
          scope,
          count: 0,
        },
      };
    }

    return {
      output: matches
        .map((match, index) =>
          `${index + 1}. [${match.source}] ${match.path}:${match.line}\n   ${match.preview}`,
        )
        .join('\n\n'),
      metadata: {
        query: args.query.trim(),
        scope,
        count: matches.length,
        matches,
      },
    };
  },
};
