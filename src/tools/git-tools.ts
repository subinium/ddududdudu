import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Tool } from './index.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 8 * 1024 * 1024;

const truncateUtf8 = (text: string, maxBytes: number): { text: string; truncated: boolean } => {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }

  return {
    text: `${encoded.subarray(0, maxBytes).toString('utf8').trimEnd()}\n\n[truncated]`,
    truncated: true,
  };
};

const parseMaxBytes = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(2 * 1024, Math.min(256 * 1024, Math.floor(value)));
};

const PATCH_FILE_PATTERN = /^\+\+\+\s+b\/(.+)$/gm;

const extractPatchFiles = (diff: string): string[] => {
  const files = new Set<string>();
  PATCH_FILE_PATTERN.lastIndex = 0;
  let match = PATCH_FILE_PATTERN.exec(diff);
  while (match) {
    const filePath = match[1]?.trim();
    if (filePath) {
      files.add(filePath);
    }
    match = PATCH_FILE_PATTERN.exec(diff);
  }

  return Array.from(files.values());
};

const parseNumstat = (
  value: string,
): { files: string[]; insertions: number; deletions: number } => {
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [added, removed, ...rest] = trimmed.split('\t');
    const filePath = rest.join('\t').trim();
    if (!filePath) {
      continue;
    }
    files.push(filePath);
    if (/^\d+$/.test(added)) {
      insertions += Number.parseInt(added, 10);
    }
    if (/^\d+$/.test(removed)) {
      deletions += Number.parseInt(removed, 10);
    }
  }

  return { files, insertions, deletions };
};

const runGit = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });

  return stdout.trimEnd();
};

const resolveRepoRoot = async (cwd: string): Promise<string | null> => {
  try {
    return await runGit(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
};

const parseStatusCounts = (statusOutput: string): Record<string, number> => {
  const counts = {
    modified: 0,
    added: 0,
    deleted: 0,
    renamed: 0,
    untracked: 0,
    conflicted: 0,
  };

  for (const rawLine of statusOutput.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith('##')) {
      continue;
    }

    const code = line.slice(0, 2);
    if (code.includes('U')) {
      counts.conflicted += 1;
      continue;
    }
    if (code.includes('R')) {
      counts.renamed += 1;
    }
    if (code.includes('A')) {
      counts.added += 1;
    }
    if (code.includes('D')) {
      counts.deleted += 1;
    }
    if (code.includes('M')) {
      counts.modified += 1;
    }
    if (code === '??') {
      counts.untracked += 1;
    }
  }

  return counts;
};

export const gitStatusTool: Tool = {
  definition: {
    name: 'git_status',
    description: 'Inspect repository status in a concise, structured form.',
    parameters: {
      path: { type: 'string', description: 'Optional path to scope status output.' },
    },
  },
  async execute(args, ctx) {
    const repoRoot = await resolveRepoRoot(ctx.cwd);
    if (!repoRoot) {
      return {
        output: 'Not inside a git repository.',
        isError: true,
      };
    }

    const scopedPath = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : null;
    const commandArgs = ['status', '--short', '--branch'];
    if (scopedPath) {
      commandArgs.push('--', scopedPath);
    }

    try {
      const output = await runGit(ctx.cwd, commandArgs);
      const counts = parseStatusCounts(output);

      return {
        output: output || 'Working tree clean.',
        metadata: {
          repoRoot,
          path: scopedPath,
          counts,
          clean: !output.split('\n').some((line) => line && !line.startsWith('##')),
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

export const gitDiffTool: Tool = {
  definition: {
    name: 'git_diff',
    description: 'Read a git diff with optional staging scope, path filter, or stat-only mode.',
    parameters: {
      path: { type: 'string', description: 'Optional path to scope the diff.' },
      staged: { type: 'boolean', description: 'Read the staged diff instead of the working tree diff.' },
      stat_only: { type: 'boolean', description: 'Return diff stats instead of the full patch.' },
      max_bytes: { type: 'number', description: 'Maximum UTF-8 bytes to keep from the diff output.' },
    },
  },
  async execute(args, ctx) {
    const repoRoot = await resolveRepoRoot(ctx.cwd);
    if (!repoRoot) {
      return {
        output: 'Not inside a git repository.',
        isError: true,
      };
    }

    const staged = args.staged === true;
    const statOnly = args.stat_only === true;
    const scopedPath = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : null;
    const maxBytes = parseMaxBytes(args.max_bytes, 64 * 1024);
    const commandArgs = ['diff', '--no-ext-diff', '--minimal'];
    if (staged) {
      commandArgs.push('--cached');
    }
    if (statOnly) {
      commandArgs.push('--stat');
    }
    if (scopedPath) {
      commandArgs.push('--', scopedPath);
    }

    try {
      const output = await runGit(ctx.cwd, commandArgs);
      const numstatArgs = ['diff', '--no-ext-diff', '--minimal', '--numstat'];
      if (staged) {
        numstatArgs.push('--cached');
      }
      if (scopedPath) {
        numstatArgs.push('--', scopedPath);
      }
      const numstat = await runGit(ctx.cwd, numstatArgs).catch(() => '');
      const parsed = parseNumstat(numstat);
      if (!output.trim()) {
        return {
          output: staged ? 'No staged diff.' : 'No working tree diff.',
          metadata: {
            repoRoot,
            path: scopedPath,
            staged,
            statOnly,
            truncated: false,
            files: [],
            fileCount: 0,
            insertions: 0,
            deletions: 0,
            summary: staged ? 'no staged changes' : 'no working tree changes',
          },
        };
      }

      const truncated = truncateUtf8(output, maxBytes);
      return {
        output: truncated.text,
        metadata: {
          repoRoot,
          path: scopedPath,
          staged,
          statOnly,
          truncated: truncated.truncated,
          maxBytes,
          files: parsed.files,
          fileCount: parsed.files.length,
          insertions: parsed.insertions,
          deletions: parsed.deletions,
          summary: `${parsed.files.length} file${parsed.files.length === 1 ? '' : 's'} changed · +${parsed.insertions} -${parsed.deletions}`,
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

export const patchApplyTool: Tool = {
  definition: {
    name: 'patch_apply',
    description: 'Validate or apply a unified diff patch against the current repository.',
    parameters: {
      patch: { type: 'string', description: 'Unified diff patch to validate or apply.', required: true },
      check: { type: 'boolean', description: 'Only validate the patch without applying it.' },
      reverse: { type: 'boolean', description: 'Apply the patch in reverse.' },
    },
  },
  async execute(args, ctx) {
    if (typeof args.patch !== 'string' || args.patch.trim().length === 0) {
      return {
        output: 'Missing required argument: patch',
        isError: true,
      };
    }

    const repoRoot = await resolveRepoRoot(ctx.cwd);
    if (!repoRoot) {
      return {
        output: 'Not inside a git repository.',
        isError: true,
      };
    }

    const checkOnly = args.check === true;
    const reverse = args.reverse === true;
    const tempDir = resolve(repoRoot, '.ddudu', 'tmp');
    const patchPath = resolve(tempDir, `tool-${Date.now().toString(36)}.patch`);

    try {
      await mkdir(tempDir, { recursive: true });
      await writeFile(patchPath, args.patch, 'utf8');
      const files = extractPatchFiles(args.patch);
      const summary =
        files.length > 0
          ? `${files.length} file${files.length === 1 ? '' : 's'} touched`
          : 'patch parsed';

      const baseArgs = ['apply', '--whitespace=nowarn'];
      if (reverse) {
        baseArgs.push('--reverse');
      }

      await runGit(repoRoot, [...baseArgs, '--check', patchPath]);
      if (checkOnly) {
        return {
          output: 'Patch check passed.',
          metadata: {
            repoRoot,
            checkOnly: true,
            reverse,
            files,
            fileCount: files.length,
            summary,
          },
        };
      }

      await runGit(repoRoot, [...baseArgs, patchPath]);
      return {
        output: 'Patch applied successfully.',
          metadata: {
            repoRoot,
            checkOnly: false,
            reverse,
            files,
            fileCount: files.length,
            summary,
          },
        };
      } catch (error: unknown) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
        metadata: {
          repoRoot,
          checkOnly,
          reverse,
          files: extractPatchFiles(args.patch),
          fileCount: extractPatchFiles(args.patch).length,
        },
      };
    } finally {
      await rm(patchPath, { force: true }).catch(() => {});
    }
  },
};
