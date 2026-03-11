import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { LspDocumentSymbol, LspResolvedLocation, LspWorkspaceSymbol } from '../core/lsp-manager.js';
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

const symbolKindLabel = (kind: number | undefined): string => {
  switch (kind) {
    case 5:
      return 'class';
    case 6:
      return 'method';
    case 12:
      return 'function';
    case 13:
      return 'variable';
    case 23:
      return 'struct';
    case 11:
      return 'interface';
    default:
      return 'symbol';
  }
};

const symbolMatchScore = (
  query: string,
  symbol: LspDocumentSymbol,
  rootPath: string,
): number => {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedName = symbol.name.toLowerCase();
  const relPath = normalizePath(relative(rootPath, symbol.filePath));
  let score = 0;
  if (normalizedName === normalizedQuery) {
    score += 10;
  } else if (normalizedName.startsWith(normalizedQuery)) {
    score += 6;
  } else if (normalizedName.includes(normalizedQuery)) {
    score += 3;
  }

  if (relPath.toLowerCase().includes(normalizedQuery)) {
    score += 2;
  }

  return score;
};

const readLineAt = async (filePath: string, zeroBasedLine: number): Promise<string | null> => {
  try {
    const text = await readTextFile(filePath);
    if (!text) {
      return null;
    }
    const lines = text.split('\n');
    return lines[zeroBasedLine]?.trim() ?? null;
  } catch {
    return null;
  }
};

const withTimeout = async <T>(
  promise: Promise<T>,
  fallback: T,
  timeoutMs: number = 1_500,
): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]);
};

const findQueryPositionsInFile = async (
  filePath: string,
  query: string,
  maxPositions: number,
): Promise<Array<{ line: number; character: number }>> => {
  const text = await readTextFile(filePath);
  if (!text) {
    return [];
  }

  const positions: Array<{ line: number; character: number }> = [];
  const lines = text.split('\n');
  const pattern = buildReferencePattern(query);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (positions.length >= maxPositions) {
      break;
    }

    const line = lines[lineIndex];
    const match = pattern.exec(line);
    if (!match || match.index < 0) {
      continue;
    }

    positions.push({
      line: lineIndex,
      character: match.index,
    });
  }

  return positions;
};

const collectCandidateFilesForSymbol = async (
  rootPath: string,
  query: string,
  maxFiles: number,
): Promise<string[]> => {
  const files = await walkFiles(rootPath, DEFAULT_EXCLUDES);
  const patterns = SYMBOL_PATTERNS(query.trim());
  const needle = query.trim().toLowerCase();
  const matches: string[] = [];

  for (const filePath of files) {
    if (matches.length >= maxFiles) {
      break;
    }

    const relPath = normalizePath(relative(rootPath, filePath));
    if (relPath.toLowerCase().includes(needle)) {
      matches.push(filePath);
      continue;
    }

    const text = await readTextFile(filePath);
    if (!text) {
      continue;
    }

    const lines = text.split('\n');
    if (lines.some((line) => patterns.some((pattern) => pattern.test(line)))) {
      matches.push(filePath);
    }
  }

  return matches;
};

const collectCandidateFilesForReferences = async (
  rootPath: string,
  query: string,
  maxFiles: number,
): Promise<string[]> => {
  const files = await walkFiles(rootPath, DEFAULT_EXCLUDES);
  const pattern = buildReferencePattern(query);
  const matches: string[] = [];

  for (const filePath of files) {
    if (matches.length >= maxFiles) {
      break;
    }

    const text = await readTextFile(filePath);
    if (!text || !pattern.test(text)) {
      continue;
    }

    matches.push(filePath);
  }

  return matches;
};

const tryLspDefinitionSearch = async (
  query: string,
  rootPath: string,
  maxResults: number,
  ctx: {
    lsp?: {
      supportsFile: (filePath: string) => boolean;
      documentSymbols: (filePath: string) => Promise<LspDocumentSymbol[]>;
      workspaceSymbols: (query: string, filePath: string) => Promise<LspWorkspaceSymbol[]>;
      definition: (filePath: string, position: { line: number; character: number }) => Promise<LspResolvedLocation[]>;
    };
  },
): Promise<{ output: string; count: number } | null> => {
  if (!ctx.lsp) {
    return null;
  }

  const candidateFiles = (await collectCandidateFilesForSymbol(rootPath, query, Math.max(maxResults * 2, 10)))
    .filter((filePath) => ctx.lsp?.supportsFile(filePath));
  if (candidateFiles.length === 0) {
    return null;
  }

  const matches: Array<{ score: number; path: string; line: string }> = [];
  for (const filePath of candidateFiles) {
    let symbols: LspDocumentSymbol[] = [];
    try {
      const workspaceSymbols = await withTimeout(ctx.lsp.workspaceSymbols(query, filePath), []);
      symbols =
        workspaceSymbols.length > 0
          ? workspaceSymbols.map((symbol) => ({
              name: symbol.name,
              detail: symbol.detail,
              kind: symbol.kind,
              filePath: symbol.filePath,
              range: symbol.range,
              selectionRange: symbol.range,
            }))
          : await withTimeout(ctx.lsp.documentSymbols(filePath), []);
    } catch {
      symbols = [];
    }

    if (symbols.length === 0) {
      const positions = await findQueryPositionsInFile(filePath, query, 3);
      for (const position of positions) {
        let definitionLocations: LspResolvedLocation[] = [];
        try {
          definitionLocations = await withTimeout(ctx.lsp.definition(filePath, position), []);
        } catch {
          definitionLocations = [];
        }

        for (const location of definitionLocations) {
          const relPath = normalizePath(relative(rootPath, location.filePath));
          const line = await readLineAt(location.filePath, location.line);
          const snippet = `${relPath}:${location.line + 1}:${location.character + 1}: ${line ?? query.trim()}`;
          matches.push({
            score: relPath === normalizePath(relative(rootPath, filePath)) ? 8 : 6,
            path: relPath,
            line: snippet,
          });
        }
      }
    }

    for (const symbol of symbols) {
      const score = symbolMatchScore(query, symbol, rootPath);
      if (score <= 0) {
        continue;
      }
      const relPath = normalizePath(relative(rootPath, symbol.filePath));
      const line = await readLineAt(symbol.filePath, symbol.selectionRange.start.line);
      matches.push({
        score,
        path: relPath,
        line: `${relPath}:${symbol.selectionRange.start.line + 1}:${symbol.selectionRange.start.character + 1}: ${symbolKindLabel(symbol.kind)} ${symbol.name}${line ? ` · ${line}` : ''}`,
      });
    }
  }

  if (matches.length === 0) {
    return null;
  }

  const output = renderGroupedMatches(
    matches.map((match) => ({ path: match.path, line: match.line, score: match.score })),
    maxResults,
    3,
  );

  return {
    output,
    count: Math.min(new Set(matches.map((match) => match.path)).size, maxResults),
  };
};

const tryLspReferenceSearch = async (
  query: string,
  rootPath: string,
  maxResults: number,
  ctx: {
    lsp?: {
      supportsFile: (filePath: string) => boolean;
      documentSymbols: (filePath: string) => Promise<LspDocumentSymbol[]>;
      workspaceSymbols: (query: string, filePath: string) => Promise<LspWorkspaceSymbol[]>;
      definition: (filePath: string, position: { line: number; character: number }) => Promise<LspResolvedLocation[]>;
      references: (filePath: string, position: { line: number; character: number }) => Promise<LspResolvedLocation[]>;
    };
  },
): Promise<Array<{ path: string; line: string; score: number }> | null> => {
  if (!ctx.lsp) {
    return null;
  }

  const candidateFiles = (await collectCandidateFilesForReferences(rootPath, query, 12))
    .filter((filePath) => ctx.lsp?.supportsFile(filePath));
  if (candidateFiles.length === 0) {
    return null;
  }

  const definitionCandidates: Array<{ symbol: LspDocumentSymbol; score: number }> = [];
  for (const filePath of candidateFiles) {
    let symbols: LspDocumentSymbol[] = [];
    try {
      const workspaceSymbols = await withTimeout(ctx.lsp.workspaceSymbols(query, filePath), []);
      symbols =
        workspaceSymbols.length > 0
          ? workspaceSymbols.map((symbol) => ({
              name: symbol.name,
              detail: symbol.detail,
              kind: symbol.kind,
              filePath: symbol.filePath,
              range: symbol.range,
              selectionRange: symbol.range,
            }))
          : await withTimeout(ctx.lsp.documentSymbols(filePath), []);
    } catch {
      symbols = [];
    }

    if (symbols.length === 0) {
      const positions = await findQueryPositionsInFile(filePath, query, 3);
      for (const position of positions) {
        let definitionLocations: LspResolvedLocation[] = [];
        try {
          definitionLocations = await withTimeout(ctx.lsp.definition(filePath, position), []);
        } catch {
          definitionLocations = [];
        }
        for (const location of definitionLocations) {
          definitionCandidates.push({
            symbol: {
              name: query.trim(),
              filePath: location.filePath,
              range: {
                start: { line: location.line, character: location.character },
                end: { line: location.endLine, character: location.endCharacter },
              },
              selectionRange: {
                start: { line: location.line, character: location.character },
                end: { line: location.endLine, character: location.endCharacter },
              },
            },
            score: 8,
          });
        }
      }
    }

    for (const symbol of symbols) {
      const score = symbolMatchScore(query, symbol, rootPath);
      if (score > 0) {
        definitionCandidates.push({ symbol, score });
      }
    }
  }

  definitionCandidates.sort((a, b) => b.score - a.score || a.symbol.filePath.localeCompare(b.symbol.filePath));
  if (definitionCandidates.length === 0) {
    return null;
  }

  const matches: Array<{ path: string; line: string; score: number }> = [];
  for (const candidate of definitionCandidates.slice(0, 4)) {
    const references = await withTimeout(
      ctx.lsp.references(candidate.symbol.filePath, candidate.symbol.selectionRange.start),
      [],
    );
    for (const reference of references) {
      const relPath = normalizePath(relative(rootPath, reference.filePath));
      const snippet = await readLineAt(reference.filePath, reference.line);
      matches.push({
        path: relPath,
        score: candidate.score + (reference.filePath === candidate.symbol.filePath ? 1 : 3),
        line: `${relPath}:${reference.line + 1}:${reference.character + 1}: ${snippet ?? query.trim()}`,
      });
    }
    if (matches.length >= maxResults * 2) {
      break;
    }
  }

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => b.score - a.score || a.line.localeCompare(b.line));
  return matches.slice(0, maxResults * 2);
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

const applyRankedOutputScores = (
  scores: Map<string, { score: number; reasons: Set<string>; lines: string[] }>,
  output: string,
  weightMultiplier: number,
  reason: string,
): void => {
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('# ')) {
      continue;
    }
    const match = /^#\s+(.+?)\s+\(score\s+(\d+)/u.exec(line);
    if (!match) {
      continue;
    }
    const filePath = match[1]?.trim();
    const score = Number.parseInt(match[2] ?? '0', 10);
    if (!filePath || !Number.isFinite(score)) {
      continue;
    }
    const existing = scores.get(filePath) ?? { score: 0, reasons: new Set<string>(), lines: [] };
    existing.score += Math.max(1, Math.min(score, 40)) * weightMultiplier;
    existing.reasons.add(reason);
    scores.set(filePath, existing);
  }
};

const fileImportancePurposeBoost = (purpose: string | undefined, relPath: string): number => {
  const normalizedPurpose = purpose?.trim().toLowerCase();
  const lowerPath = relPath.toLowerCase();
  if (!normalizedPurpose) {
    return 0;
  }

  if (normalizedPurpose === 'execution') {
    return lowerPath.includes('test') ? 2 : 4;
  }
  if (normalizedPurpose === 'review') {
    return lowerPath.includes('test') || lowerPath.includes('spec') ? 5 : 3;
  }
  if (normalizedPurpose === 'design') {
    return lowerPath.includes('ui') || lowerPath.includes('component') || lowerPath.includes('theme') ? 5 : 2;
  }
  if (normalizedPurpose === 'planning' || normalizedPurpose === 'research') {
    return lowerPath.endsWith('.md') || lowerPath.includes('docs/') ? 4 : 1;
  }

  return 0;
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
    description:
      'Find where a function, class, interface, type, or variable is defined. Use this when you know the symbol name and need its declaration site. ' +
      'Default mode ("scan") returns a flat list of matching definition lines across the project. ' +
      'Set mode to "resolve" for a precise, LSP-backed lookup with changed-file bias and results grouped by file — ' +
      'use "resolve" when you need the exact definition of a specific identifier. ' +
      'Do NOT use this tool for finding usages/call-sites — use reference_search instead.',
    parameters: {
      query: { type: 'string', description: 'Symbol name or partial name to search for.', required: true },
      path: { type: 'string', description: 'Base path for searching.' },
      mode: {
        type: 'string',
        description: 'Search mode. "scan" (default): broad regex scan for definition patterns. "resolve": precise LSP-backed lookup with changed-file bias, grouped by file.',
        enum: ['scan', 'resolve'],
      },
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
    const mode = args.mode === 'resolve' ? 'resolve' : 'scan';
    const maxResults =
      typeof args.max_results === 'number' && Number.isFinite(args.max_results)
        ? Math.max(1, Math.floor(args.max_results))
        : mode === 'resolve' ? 8 : 60;

    try {
      const lspResult = await tryLspDefinitionSearch(args.query.trim(), rootPath, maxResults, ctx);

      // --- resolve mode: grouped output with changed-file bias ---
      if (mode === 'resolve') {
        if (lspResult) {
          return {
            output: lspResult.output,
            metadata: { root: rootPath, count: lspResult.count, source: 'lsp', mode },
          };
        }

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
            mode,
          },
        };
      }

      // --- scan mode (default): flat list ---
      if (lspResult) {
        return {
          output: lspResult.output,
          metadata: { root: rootPath, count: lspResult.count, source: 'lsp', mode },
        };
      }

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
        metadata: { root: rootPath, count: results.length, mode },
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
    description:
      'Find where a symbol is used across the codebase (imports, calls, assignments, type references). ' +
      'Use this when you need to understand the impact of changing a function, type, or variable. ' +
      'Default output is a flat scored list of matching lines. ' +
      'Set group_by_file to true to aggregate results by file and find the hotspot files with the most references — ' +
      'useful before refactoring to see which files will be affected. ' +
      'Do NOT use this for finding definitions — use symbol_search instead.',
    parameters: {
      query: { type: 'string', description: 'Identifier or symbol reference to search for.', required: true },
      path: { type: 'string', description: 'Base path for searching.' },
      group_by_file: {
        type: 'boolean',
        description: 'When true, aggregate results by file and show the top hotspot files with representative lines. Default: false.',
      },
      max_results: { type: 'number', description: 'Maximum lines (or files when group_by_file) to return.' },
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
    const groupByFile = args.group_by_file === true;
    const maxResults =
      typeof args.max_results === 'number' && Number.isFinite(args.max_results)
        ? Math.max(1, Math.floor(args.max_results))
        : groupByFile ? 8 : 80;

    try {
      const lspMatches = await tryLspReferenceSearch(args.query.trim(), rootPath, maxResults, ctx);
      if (lspMatches && lspMatches.length > 0) {
        if (groupByFile) {
          return {
            output: renderGroupedMatches(lspMatches, maxResults, 3),
            metadata: {
              root: rootPath,
              count: Math.min(new Set(lspMatches.map((match) => match.path)).size, maxResults),
              source: 'lsp',
              groupByFile,
            },
          };
        }
        return {
          output: lspMatches.map((entry) => entry.line).join('\n'),
          metadata: {
            root: rootPath,
            count: Math.min(lspMatches.length, maxResults),
            source: 'lsp',
            groupByFile,
          },
        };
      }

      const files = await walkFiles(rootPath, DEFAULT_EXCLUDES);
      const pattern = buildReferencePattern(args.query);
      const changedFiles = new Set(await getChangedFiles(rootPath));
      const matches: Array<{ path: string; score: number; line: string }> = [];

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

          const skipDefinition = groupByFile && isDefinitionLine(args.query, line);
          if (skipDefinition) {
            continue;
          }

          let score = changedFiles.has(relPath) ? (groupByFile ? 5 : 4) : (groupByFile ? 2 : 0);
          if (!groupByFile && !isDefinitionLine(args.query, line)) {
            score += 3;
          }
          if (line.includes(args.query.trim())) {
            score += 1;
          }

          matches.push({
            path: relPath,
            score,
            line: `${relPath}:${index + 1}: ${line.trim()}`,
          });
        }
      }

      if (groupByFile) {
        const output = renderGroupedMatches(matches, maxResults, 3);
        return {
          output,
          metadata: {
            root: rootPath,
            count: Math.min(new Set(matches.map((match) => match.path)).size, maxResults),
            groupByFile,
          },
        };
      }

      matches.sort((a, b) => b.score - a.score || a.line.localeCompare(b.line));
      const output = matches.slice(0, maxResults).map((entry) => entry.line).join('\n');

      return {
        output,
        metadata: {
          root: rootPath,
          count: Math.min(matches.length, maxResults),
          groupByFile,
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

/** @deprecated Merged into symbolSearchTool with mode="resolve". Kept as alias for backward compatibility. */
export const definitionSearchTool: Tool = {
  ...symbolSearchTool,
  definition: {
    ...symbolSearchTool.definition,
    name: 'definition_search',
    description: 'Alias for symbol_search with mode="resolve". Prefer symbol_search directly.',
  },
  async execute(args, ctx) {
    return symbolSearchTool.execute({ ...args, mode: 'resolve' }, ctx);
  },
};

/** @deprecated Merged into referenceSearchTool with group_by_file=true. Kept as alias for backward compatibility. */
export const referenceHotspotsTool: Tool = {
  ...referenceSearchTool,
  definition: {
    ...referenceSearchTool.definition,
    name: 'reference_hotspots',
    description: 'Alias for reference_search with group_by_file=true. Prefer reference_search directly.',
  },
  async execute(args, ctx) {
    return referenceSearchTool.execute({ ...args, group_by_file: true }, ctx);
  },
};

export const changedFilesTool: Tool = {
  definition: {
    name: 'changed_files',
    description:
      'List files with uncommitted changes (staged + unstaged) in the current git worktree. ' +
      'Use this to scope edits to files the user is actively working on, or to check what has been modified before committing.',
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
    description:
      'Search the codebase with a natural-language query when you do not know the exact text to find. ' +
      'Scores files and lines by keyword overlap, path relevance, and changed-file recency. ' +
      'Use this for exploratory questions like "where is auth handled" or "find error boundary logic". ' +
      'For exact text or regex matches, use grep instead. For ranking which files matter most for a task, use file_importance.',
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

export const fileImportanceTool: Tool = {
  definition: {
    name: 'file_importance',
    description:
      'Rank which files matter most for the current task using changed-file recency, path matching, line-match density, and LSP definition/reference signals. ' +
      'Use this at the start of a task to decide which files to read first. ' +
      'Unlike codebase_search (which returns matching lines), this returns a ranked file list with reason annotations.',
    parameters: {
      query: { type: 'string', description: 'Natural-language request or keyword set.', required: true },
      path: { type: 'string', description: 'Base path for ranking.' },
      purpose: { type: 'string', description: 'Optional request purpose such as execution, review, planning, design, or research.' },
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
    const purpose = typeof args.purpose === 'string' && args.purpose.trim().length > 0 ? args.purpose.trim() : undefined;
    const maxResults =
      typeof args.max_results === 'number' && Number.isFinite(args.max_results)
        ? Math.max(1, Math.floor(args.max_results))
        : 8;
    const tokens = tokenizeQuery(args.query);

    if (tokens.length === 0) {
      return { output: 'Query did not contain enough searchable tokens.', isError: true };
    }

    try {
      const files = await walkFiles(rootPath, DEFAULT_EXCLUDES);
      const changedFiles = new Set(await getChangedFiles(rootPath));
      const scores = new Map<string, { score: number; reasons: Set<string>; lines: string[] }>();
      const addSignal = (filePath: string, score: number, reason: string, line?: string): void => {
        if (score <= 0) {
          return;
        }
        const existing = scores.get(filePath) ?? { score: 0, reasons: new Set<string>(), lines: [] };
        existing.score += score;
        existing.reasons.add(reason);
        if (line && existing.lines.length < 3) {
          existing.lines.push(line);
        }
        scores.set(filePath, existing);
      };

      const significantTokens = tokens.filter((token) => token.length >= 3).slice(0, 4);
      for (const filePath of files) {
        const relPath = normalizePath(relative(rootPath, filePath));
        const lowerPath = relPath.toLowerCase();
        const pathTokens = tokens.filter((token) => lowerPath.includes(token));
        let score = changedFileBoost(tokens, relPath, changedFiles);
        score += fileImportancePurposeBoost(purpose, relPath);
        if (pathTokens.length > 0) {
          score += pathTokens.length * 4;
        }
        if (changedFiles.has(relPath)) {
          addSignal(relPath, score, 'changed');
        } else if (score > 0) {
          addSignal(relPath, score, pathTokens.length > 0 ? `path:${pathTokens[0]}` : 'path');
        }

        const text = await readTextFile(filePath);
        if (!text) {
          continue;
        }
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const rawLine = lines[index] ?? '';
          const lowerLine = rawLine.toLowerCase();
          let lineScore = 0;
          let matchedToken: string | null = null;
          for (const token of significantTokens) {
            if (lowerLine.includes(token)) {
              lineScore += 2;
              matchedToken ??= token;
            }
          }
          if (lineScore <= 0) {
            continue;
          }
          addSignal(relPath, lineScore, matchedToken ? `line:${matchedToken}` : 'line', `${relPath}:${index + 1}: ${rawLine.trim()}`);
        }
      }

      const lspTokens = significantTokens.filter((token) => !CHANGE_PATTERNS.includes(token)).slice(0, 3);
      for (const token of lspTokens) {
        const definitionResult = await tryLspDefinitionSearch(token, rootPath, Math.max(maxResults, 6), ctx);
        if (definitionResult) {
          applyRankedOutputScores(scores, definitionResult.output, 3, `definition:${token}`);
        }
        const referenceMatches = await tryLspReferenceSearch(token, rootPath, Math.max(maxResults, 6), ctx);
        if (referenceMatches && referenceMatches.length > 0) {
          for (const match of referenceMatches) {
            addSignal(match.path, match.score * 2, `references:${token}`, match.line);
          }
        }
      }

      const ranked = Array.from(scores.entries())
        .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
        .slice(0, maxResults);

      if (ranked.length === 0) {
        return {
          output: '',
          metadata: {
            root: rootPath,
            count: 0,
            purpose,
            tokens,
          },
        };
      }

      return {
        output: ranked
          .map(([path, entry]) => {
            const reasons = Array.from(entry.reasons).slice(0, 3).join(', ');
            const reasonLine = reasons ? `signals: ${reasons}` : null;
            return [
              `# ${path} (score ${entry.score})`,
              ...(reasonLine ? [reasonLine] : []),
              ...entry.lines.slice(0, 2),
            ].join('\n');
          })
          .join('\n\n'),
        metadata: {
          root: rootPath,
          count: ranked.length,
          purpose,
          tokens,
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
