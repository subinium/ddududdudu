import { spawn } from 'node:child_process';

import type { Tool } from './index.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 100 * 1024;

export const bashTool: Tool = {
  definition: {
    name: 'bash',
    description: 'Execute a shell command in the current working directory.',
    parameters: {
      command: { type: 'string', description: 'Shell command to execute.', required: true },
      timeout: { type: 'number', description: 'Execution timeout in milliseconds.' },
    },
  },
  async execute(args, ctx) {
    if (typeof args.command !== 'string' || args.command.trim().length === 0) {
      return { output: 'Missing required argument: command', isError: true };
    }
    const command = args.command;

    const timeout =
      typeof args.timeout === 'number' && Number.isFinite(args.timeout)
        ? Math.max(1, Math.floor(args.timeout))
        : DEFAULT_TIMEOUT_MS;

    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', command], {
        cwd: ctx.cwd,
      });

      let combinedOutput = '';
      let capturedBytes = 0;
      let wasTruncated = false;
      let timeoutTriggered = false;
      let aborted = false;

      const appendOutput = (text: string): void => {
        if (wasTruncated || text.length === 0) {
          return;
        }

        const chunkBytes = Buffer.byteLength(text, 'utf8');
        const remaining = MAX_OUTPUT_BYTES - capturedBytes;

        if (chunkBytes <= remaining) {
          combinedOutput += text;
          capturedBytes += chunkBytes;
          return;
        }

        const allowed = Buffer.from(text, 'utf8').subarray(0, Math.max(remaining, 0));
        combinedOutput += allowed.toString('utf8');
        combinedOutput += '\n[output truncated: exceeded 100KB]\n';
        capturedBytes = MAX_OUTPUT_BYTES;
        wasTruncated = true;
      };

      const onAbort = (): void => {
        aborted = true;
        child.kill('SIGTERM');
      };

      ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });

      const timeoutId = setTimeout(() => {
        timeoutTriggered = true;
        child.kill('SIGTERM');
      }, timeout);

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        appendOutput(text);
        ctx.onProgress?.(text);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        appendOutput(text);
        ctx.onProgress?.(text);
      });

      child.on('error', (err: Error) => {
        clearTimeout(timeoutId);
        ctx.abortSignal?.removeEventListener('abort', onAbort);
        resolve({ output: `Failed to start command: ${err.message}`, isError: true });
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timeoutId);
        ctx.abortSignal?.removeEventListener('abort', onAbort);

        const exitCode = code ?? -1;
        const trailer = `\n\n[exit_code=${exitCode}${signal ? `, signal=${signal}` : ''}]`;
        const output = combinedOutput + trailer;

        if (aborted) {
          resolve({ output: `${output}\n[aborted]`, isError: true, metadata: { exitCode, signal } });
          return;
        }

        if (timeoutTriggered) {
          resolve({
            output: `${output}\n[timeout after ${timeout}ms]`,
            isError: true,
            metadata: { exitCode, signal, timeout },
          });
          return;
        }

        resolve({
          output,
          isError: exitCode !== 0,
          metadata: { exitCode, signal, timeout },
        });
      });
    });
  },
};
