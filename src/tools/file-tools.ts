import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

import type { LspDocumentSymbol } from '../core/lsp-manager.js';
import type { Tool, ToolContext } from './index.js';

const isBinaryBuffer = (buffer: Buffer): boolean => {
  const length = Math.min(buffer.length, 512);
  for (let index = 0; index < length; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }

  return false;
};

const toPath = (cwd: string, value: unknown): string | null => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  return resolve(cwd, value);
};

const parsePositiveInt = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.floor(value);
  return normalized >= 1 ? normalized : null;
};

const renderDiffSummary = (before: string, after: string): string => {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const max = Math.max(beforeLines.length, afterLines.length);
  const lines: string[] = [];

  for (let index = 0; index < max && lines.length < 12; index += 1) {
    const previous = beforeLines[index];
    const next = afterLines[index];
    if (previous === next) {
      continue;
    }
    if (previous !== undefined) {
      lines.push(`- ${previous}`);
    }
    if (next !== undefined) {
      lines.push(`+ ${next}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : 'no visible diff';
};

const clampRange = (
  totalLines: number,
  startLine: number,
  endLine: number,
): { startLine: number; endLine: number } => {
  const clampedStart = Math.min(Math.max(1, startLine), Math.max(totalLines, 1));
  const clampedEnd = Math.min(Math.max(clampedStart, endLine), Math.max(totalLines, clampedStart));
  return {
    startLine: clampedStart,
    endLine: clampedEnd,
  };
};

const renderNumberedLines = (
  lines: string[],
  startLine: number,
  endLine: number,
): string => {
  return lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join('\n');
};

const symbolScore = (query: string, symbol: LspDocumentSymbol): number => {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedName = symbol.name.toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedName === normalizedQuery) {
    return 12;
  }
  if (normalizedName.startsWith(normalizedQuery)) {
    return 8;
  }
  if (normalizedName.includes(normalizedQuery)) {
    return 5;
  }
  if ((symbol.detail ?? '').toLowerCase().includes(normalizedQuery)) {
    return 3;
  }

  return 0;
};

const resolveSymbolSelection = async (
  filePath: string,
  query: string,
  around: number,
  totalLines: number,
  lsp: ToolContext['lsp'],
): Promise<{
  startLine: number;
  endLine: number;
  matchedSymbol: string;
} | null> => {
  if (!lsp || typeof lsp.documentSymbols !== 'function') {
    return null;
  }

  try {
    const symbols = await lsp.documentSymbols(filePath);
    const match = symbols
      .map((symbol) => ({ symbol, score: symbolScore(query, symbol) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        return right.score - left.score
          || left.symbol.range.start.line - right.symbol.range.start.line;
      })[0];

    if (!match) {
      return null;
    }

    const startLine = match.symbol.range.start.line + 1;
    const endLine = Math.max(startLine, match.symbol.range.end.line + 1);
    const range = clampRange(totalLines, startLine - around, endLine + around);
    return {
      startLine: range.startLine,
      endLine: range.endLine,
      matchedSymbol: match.symbol.name,
    };
  } catch {
    return null;
  }
};

const findMatchSelections = (
  lines: string[],
  query: string,
  before: number,
  after: number,
  maxMatches: number,
): Array<{
  matchLine: number;
  startLine: number;
  endLine: number;
}> => {
  const normalizedQuery = query.toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const ranges: Array<{ matchLine: number; startLine: number; endLine: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.toLowerCase().includes(normalizedQuery)) {
      continue;
    }

    const startLine = Math.max(1, index + 1 - before);
    const endLine = Math.min(lines.length, index + 1 + after);
    const previous = ranges[ranges.length - 1];
    if (previous && startLine <= previous.endLine + 1) {
      previous.endLine = Math.max(previous.endLine, endLine);
      continue;
    }

    ranges.push({
      matchLine: index + 1,
      startLine,
      endLine,
    });

    if (ranges.length >= maxMatches) {
      break;
    }
  }

  return ranges;
};

export const readFileTool: Tool = {
  definition: {
    name: 'read_file',
    description: 'Read a text file with line numbers, optionally by range, symbol, or matching lines.',
    parameters: {
      path: { type: 'string', description: 'Path to read.', required: true },
      offset: { type: 'number', description: '1-based line offset.' },
      limit: { type: 'number', description: 'Maximum number of lines to return.' },
      startLine: { type: 'number', description: '1-based start line for an explicit range.' },
      endLine: { type: 'number', description: '1-based end line for an explicit range.' },
      match: { type: 'string', description: 'Match string to center the snippet around.' },
      before: { type: 'number', description: 'Lines of context before each match.' },
      after: { type: 'number', description: 'Lines of context after each match.' },
      maxMatches: { type: 'number', description: 'Maximum match snippets to return.' },
      symbol: { type: 'string', description: 'Symbol name to resolve with LSP and read around.' },
    },
  },
  async execute(args, ctx) {
    const filePath = toPath(ctx.cwd, args.path);
    if (!filePath) {
      return { output: 'Missing required argument: path', isError: true };
    }

    const rawOffset = typeof args.offset === 'number' ? Math.floor(args.offset) : 1;
    const rawLimit = typeof args.limit === 'number' ? Math.floor(args.limit) : 2000;
    const offset = Math.max(rawOffset, 1);
    const limit = Math.max(rawLimit, 1);

    try {
      const buffer = await readFile(filePath);
      if (isBinaryBuffer(buffer)) {
        return { output: `Binary file detected: ${filePath}`, isError: true };
      }

      const content = buffer.toString('utf8');
      const lines = content.split('\n');
      const around =
        parsePositiveInt(args.before) === null && parsePositiveInt(args.after) === null
          ? 3
          : 0;
      const before = parsePositiveInt(args.before) ?? around;
      const after = parsePositiveInt(args.after) ?? around;
      const maxMatches = parsePositiveInt(args.maxMatches) ?? 3;
      const explicitStart = parsePositiveInt(args.startLine);
      const explicitEnd = parsePositiveInt(args.endLine);
      const symbol = typeof args.symbol === 'string' && args.symbol.trim().length > 0
        ? args.symbol.trim()
        : null;
      const match = typeof args.match === 'string' && args.match.trim().length > 0
        ? args.match.trim()
        : null;

      let rendered: string;
      let metadata: Record<string, unknown>;

      if (symbol) {
        const selection = await resolveSymbolSelection(filePath, symbol, Math.max(before, after), lines.length, ctx.lsp);
        if (!selection) {
          return {
            output: `Could not resolve symbol "${symbol}" in ${filePath}`,
            isError: true,
          };
        }

        rendered = renderNumberedLines(lines, selection.startLine, selection.endLine);
        metadata = {
          path: filePath,
          totalLines: lines.length,
          mode: 'symbol',
          symbol,
          matchedSymbol: selection.matchedSymbol,
          startLine: selection.startLine,
          endLine: selection.endLine,
        };
      } else if (explicitStart || explicitEnd) {
        if (!explicitStart) {
          return {
            output: 'startLine is required when reading an explicit range',
            isError: true,
          };
        }

        const requestedEnd = explicitEnd ?? (explicitStart + limit - 1);
        const range = clampRange(lines.length, explicitStart, requestedEnd);
        rendered = renderNumberedLines(lines, range.startLine, range.endLine);
        metadata = {
          path: filePath,
          totalLines: lines.length,
          mode: 'range',
          startLine: range.startLine,
          endLine: range.endLine,
        };
      } else if (match) {
        const selections = findMatchSelections(lines, match, before, after, maxMatches);
        if (selections.length === 0) {
          return {
            output: `No matches for "${match}" in ${filePath}`,
            isError: true,
          };
        }

        rendered = selections
          .map((selection, index) => {
            const header = `-- match ${index + 1} at line ${selection.matchLine} --`;
            const body = renderNumberedLines(lines, selection.startLine, selection.endLine);
            return `${header}\n${body}`;
          })
          .join('\n\n');
        metadata = {
          path: filePath,
          totalLines: lines.length,
          mode: 'match',
          match,
          matchCount: selections.length,
          before,
          after,
          firstMatchLine: selections[0]?.matchLine,
        };
      } else {
        const endLine = Math.min(lines.length, offset + limit - 1);
        rendered = renderNumberedLines(lines, offset, endLine);
        metadata = {
          path: filePath,
          totalLines: lines.length,
          mode: 'offset',
          offset,
          limit,
        };
      }

      return {
        output: rendered,
        metadata,
      };
    } catch (err: unknown) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};

export const writeFileTool: Tool = {
  definition: {
    name: 'write_file',
    description: 'Write UTF-8 content to a file.',
    parameters: {
      path: { type: 'string', description: 'Path to write.', required: true },
      content: { type: 'string', description: 'File content.', required: true },
    },
  },
  async execute(args, ctx) {
    const filePath = toPath(ctx.cwd, args.path);
    if (!filePath) {
      return { output: 'Missing required argument: path', isError: true };
    }

    if (typeof args.content !== 'string') {
      return { output: 'Missing required argument: content', isError: true };
    }

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, args.content, 'utf8');
      return {
        output: `Wrote file: ${filePath}`,
        metadata: { path: filePath, bytes: Buffer.byteLength(args.content, 'utf8') },
      };
    } catch (err: unknown) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};

export const editFileTool: Tool = {
  definition: {
    name: 'edit_file',
    description: 'Edit a text file by exact replacement, range replacement, insertion, or deletion.',
    parameters: {
      path: { type: 'string', description: 'Path to edit.', required: true },
      oldString: { type: 'string', description: 'String to replace for replace/replace_all modes.' },
      newString: { type: 'string', description: 'Replacement string or inserted content.' },
      mode: {
        type: 'string',
        description: 'Edit mode.',
        enum: ['replace', 'replace_all', 'range', 'insert_before', 'insert_after', 'delete_range'],
      },
      startLine: { type: 'number', description: '1-based start line for range/delete operations.' },
      endLine: { type: 'number', description: '1-based end line for range/delete operations.' },
      line: { type: 'number', description: '1-based anchor line for insert_before/insert_after.' },
      expectedReplacements: { type: 'number', description: 'Expected replacement count for replace_all.' },
    },
  },
  async execute(args, ctx) {
    const filePath = toPath(ctx.cwd, args.path);
    if (!filePath) {
      return { output: 'Missing required argument: path', isError: true };
    }

    try {
      const content = await readFile(filePath, 'utf8');
      const mode =
        typeof args.mode === 'string' &&
        ['replace', 'replace_all', 'range', 'insert_before', 'insert_after', 'delete_range'].includes(args.mode)
          ? args.mode
          : 'replace';
      let updated = content;
      let replacementCount = 0;

      if (mode === 'replace' || mode === 'replace_all') {
        if (typeof args.oldString !== 'string') {
          return { output: 'replace modes require oldString', isError: true };
        }
        if (typeof args.newString !== 'string') {
          return { output: 'replace modes require newString', isError: true };
        }

        const matches = content.split(args.oldString).length - 1;
        if (matches === 0) {
          return {
            output: `oldString not found in ${filePath}`,
            isError: true,
          };
        }

        if (mode === 'replace') {
          if (matches !== 1) {
            return {
              output: `oldString matched ${matches} locations in ${filePath}; use replace_all or a more specific oldString`,
              isError: true,
            };
          }
          updated = content.replace(args.oldString, args.newString);
          replacementCount = 1;
        } else {
          const expected = parsePositiveInt(args.expectedReplacements);
          if (expected !== null && expected !== matches) {
            return {
              output: `expected ${expected} replacements but found ${matches} in ${filePath}`,
              isError: true,
            };
          }
          updated = content.split(args.oldString).join(args.newString);
          replacementCount = matches;
        }
      } else {
        const lines = content.split('\n');
        if (mode === 'range' || mode === 'delete_range') {
          const startLine = parsePositiveInt(args.startLine);
          const endLine = parsePositiveInt(args.endLine);
          if (!startLine || !endLine || endLine < startLine) {
            return { output: 'range modes require valid startLine and endLine', isError: true };
          }
          if (endLine > lines.length) {
            return { output: `line range ${startLine}-${endLine} exceeds ${lines.length} lines`, isError: true };
          }
          const replacement = mode === 'range'
            ? (typeof args.newString === 'string' ? args.newString : '')
            : '';
          const replacementLines = replacement.length > 0 ? replacement.split('\n') : [];
          lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
          updated = lines.join('\n');
          replacementCount = 1;
        } else {
          const line = parsePositiveInt(args.line);
          if (!line) {
            return { output: 'insert modes require line', isError: true };
          }
          if (line > lines.length) {
            return { output: `line ${line} exceeds ${lines.length} lines`, isError: true };
          }
          if (typeof args.newString !== 'string') {
            return { output: 'insert modes require newString', isError: true };
          }
          const insertionLines = args.newString.split('\n');
          const targetIndex = mode === 'insert_before' ? line - 1 : line;
          lines.splice(targetIndex, 0, ...insertionLines);
          updated = lines.join('\n');
          replacementCount = insertionLines.length;
        }
      }

      if (updated === content) {
        return {
          output: `Edit made no changes to ${filePath}`,
          isError: true,
        };
      }

      await writeFile(filePath, updated, 'utf8');
      return {
        output: `Edited file: ${filePath}`,
        metadata: {
          path: filePath,
          mode,
          replacements: replacementCount,
          diff: renderDiffSummary(content, updated),
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

export const listDirTool: Tool = {
  definition: {
    name: 'list_dir',
    description: 'List directory entries with type metadata.',
    parameters: {
      path: { type: 'string', description: 'Directory path to list.' },
    },
  },
  async execute(args, ctx) {
    const targetPath = typeof args.path === 'string' ? resolve(ctx.cwd, args.path) : ctx.cwd;

    try {
      const entries = await readdir(targetPath, { withFileTypes: true });
      const output = entries
        .map((entry) => {
          const type = entry.isDirectory()
            ? 'dir'
            : entry.isSymbolicLink()
              ? 'symlink'
              : 'file';
          return `${entry.name}\t${type}`;
        })
        .sort((a, b) => a.localeCompare(b))
        .join('\n');

      return {
        output,
        metadata: { path: targetPath, count: entries.length },
      };
    } catch (err: unknown) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
