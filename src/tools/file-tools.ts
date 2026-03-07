import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

import type { Tool } from './index.js';

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

export const readFileTool: Tool = {
  definition: {
    name: 'read_file',
    description: 'Read a text file with line numbers.',
    parameters: {
      path: { type: 'string', description: 'Path to read.', required: true },
      offset: { type: 'number', description: '1-based line offset.' },
      limit: { type: 'number', description: 'Maximum number of lines to return.' },
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
      const start = offset - 1;
      const slice = lines.slice(start, start + limit);
      const rendered = slice
        .map((line, index) => `${offset + index}: ${line}`)
        .join('\n');

      return {
        output: rendered,
        metadata: {
          path: filePath,
          totalLines: lines.length,
          offset,
          limit,
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
    description: 'Replace an exact string in a file exactly once.',
    parameters: {
      path: { type: 'string', description: 'Path to edit.', required: true },
      oldString: { type: 'string', description: 'String to replace.', required: true },
      newString: { type: 'string', description: 'Replacement string.', required: true },
    },
  },
  async execute(args, ctx) {
    const filePath = toPath(ctx.cwd, args.path);
    if (!filePath) {
      return { output: 'Missing required argument: path', isError: true };
    }

    if (typeof args.oldString !== 'string') {
      return { output: 'Missing required argument: oldString', isError: true };
    }

    if (typeof args.newString !== 'string') {
      return { output: 'Missing required argument: newString', isError: true };
    }

    try {
      const content = await readFile(filePath, 'utf8');
      const firstIndex = content.indexOf(args.oldString);
      if (firstIndex === -1) {
        return {
          output: `oldString not found in ${filePath}`,
          isError: true,
        };
      }

      const secondIndex = content.indexOf(args.oldString, firstIndex + args.oldString.length);
      if (secondIndex !== -1) {
        return {
          output: `oldString matched multiple locations in ${filePath}`,
          isError: true,
        };
      }

      const updated = content.replace(args.oldString, args.newString);
      await writeFile(filePath, updated, 'utf8');
      return {
        output: `Edited file: ${filePath}`,
        metadata: { path: filePath },
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
