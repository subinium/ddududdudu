import { spawn } from 'node:child_process';

import { DIM, GREEN, RED, RESET } from '../tui/colors.js';

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

export interface BashInputState {
  bashMode: boolean;
  command: string | null;
  toggled: boolean;
}

const chunkToString = (chunk: Buffer | string): string => {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
};

const appendByLine = (value: string, carry: string, target: string[]): string => {
  const combined = carry + value;
  const lines = combined.replace(/\r/g, '').split('\n');
  const nextCarry = lines.pop() ?? '';
  for (const line of lines) {
    target.push(line);
  }
  return nextCarry;
};

export class BashRunner {
  private readonly cwd: string;

  public constructor(cwd: string) {
    this.cwd = cwd;
  }

  public execute(command: string, signal?: AbortSignal): Promise<BashResult> {
    return new Promise((resolveResult) => {
      const startedAt = Date.now();

      if (signal?.aborted) {
        resolveResult({
          stdout: '',
          stderr: 'Aborted before execution',
          exitCode: 130,
          duration: Date.now() - startedAt,
        });
        return;
      }

      const filteredEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i.test(key) || key === 'PATH',
        ),
      );

      const child = spawn('bash', ['-lc', command], {
        cwd: this.cwd,
        env: filteredEnv,
      });

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      let stdoutCarry = '';
      let stderrCarry = '';

      const abortListener = (): void => {
        child.kill('SIGTERM');
      };

      if (signal) {
        signal.addEventListener('abort', abortListener, { once: true });
      }

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdoutCarry = appendByLine(chunkToString(chunk), stdoutCarry, stdoutLines);
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrCarry = appendByLine(chunkToString(chunk), stderrCarry, stderrLines);
      });

      child.on('error', (err: Error) => {
        if (signal) {
          signal.removeEventListener('abort', abortListener);
        }

        resolveResult({
          stdout: '',
          stderr: err.message,
          exitCode: 1,
          duration: Date.now() - startedAt,
        });
      });

      child.on('close', (code: number | null) => {
        if (signal) {
          signal.removeEventListener('abort', abortListener);
        }

        if (stdoutCarry.length > 0) {
          stdoutLines.push(stdoutCarry);
        }

        if (stderrCarry.length > 0) {
          stderrLines.push(stderrCarry);
        }

        resolveResult({
          stdout: stdoutLines.join('\n'),
          stderr: stderrLines.join('\n'),
          exitCode: code ?? (signal?.aborted ? 130 : 1),
          duration: Date.now() - startedAt,
        });
      });
    });
  }

  public formatForChat(result: BashResult, command: string): string {
    const ok = result.exitCode === 0;
    const badgeColor = ok ? GREEN : RED;
    const status = ok ? 'ok' : 'error';
    const header = `${DIM}$ ${command}${RESET}`;
    const badge = `${badgeColor}[${status}:${result.exitCode} | ${result.duration}ms]${RESET}`;
    const stdout = result.stdout.length > 0 ? result.stdout : `${DIM}(no stdout)${RESET}`;
    const stderr = result.stderr.length > 0 ? `${RED}${result.stderr}${RESET}` : '';

    return stderr.length > 0 ? [header, badge, stdout, stderr].join('\n') : [header, badge, stdout].join('\n');
  }
}

export const resolveBashInput = (input: string, bashMode: boolean): BashInputState => {
  const trimmed = input.trim();
  if (trimmed === '/bash') {
    return {
      bashMode: !bashMode,
      command: null,
      toggled: true,
    };
  }

  if (bashMode) {
    return {
      bashMode,
      command: input,
      toggled: false,
    };
  }

  if (trimmed.startsWith('!')) {
    const command = trimmed.slice(1).trim();
    return {
      bashMode,
      command,
      toggled: false,
    };
  }

  return {
    bashMode,
    command: null,
    toggled: false,
  };
};
