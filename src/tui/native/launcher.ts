import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const resolveBridgeEntrypoint = (): string => {
  return fileURLToPath(new URL('../../index.js', import.meta.url));
};

const resolveNativeBinary = async (): Promise<string | null> => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, '../ddudu-tui'),
    resolve(currentDir, '../../../tui/target/release/ddudu-tui'),
    resolve(currentDir, '../../../tui/target/debug/ddudu-tui'),
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  return null;
};

export interface NativeTuiLaunchOptions {
  resumeSessionId?: string;
}

type ExecveProcess = NodeJS.Process & {
  execve?: (file: string, args: string[], env?: Record<string, string>) => never;
};

export const startNativeTui = async (options: NativeTuiLaunchOptions = {}): Promise<void> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('ddudu native TUI requires an interactive terminal (TTY).');
  }

  if (process.env.DDUDU_TUI === 'ink') {
    throw new Error('The legacy Ink TUI has been removed. Run ddudu without DDUDU_TUI=ink.');
  }

  const binaryPath = await resolveNativeBinary();
  if (!binaryPath) {
    throw new Error('ddudu native TUI binary not found. Rebuild the project with npm run build.');
  }

  const bridgeEntrypoint = resolveBridgeEntrypoint();
  const nativeEnv = {
    ...process.env,
    DDUDU_TUI: 'native',
    ...(options.resumeSessionId
      ? { DDUDU_RESUME_SESSION_ID: options.resumeSessionId }
      : {}),
  };

  const execve = (process as ExecveProcess).execve;
  if (process.env.DDUDU_NO_EXECVE !== '1' && typeof execve === 'function') {
    execve(binaryPath, [binaryPath, '--node', process.execPath, '--bridge', bridgeEntrypoint], nativeEnv);
  }

  const launchedAt = Date.now();
  const child = spawn(
    binaryPath,
    ['--node', process.execPath, '--bridge', bridgeEntrypoint],
    {
      stdio: 'inherit',
      env: nativeEnv,
    },
  );

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolvePromise({ code, signal }));
  });

  if (result.signal) {
    throw new Error(`ddudu native TUI terminated by signal ${result.signal}`);
  }

  if ((result.code ?? 0) !== 0) {
    throw new Error(`ddudu native TUI exited with code ${result.code ?? 0}`);
  }

  if (Date.now() - launchedAt < 500) {
    throw new Error('ddudu native TUI exited immediately during startup');
  }

  process.exitCode = result.code ?? 0;
};
