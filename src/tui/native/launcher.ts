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
  if (process.argv[1]) {
    return process.argv[1];
  }

  return fileURLToPath(new URL('../../index.js', import.meta.url));
};

const resolveNativeBinary = async (): Promise<string | null> => {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, '../../native/ddudu-tui'),
    resolve(currentDir, '../../../native/ddudu-tui/target/release/ddudu-tui'),
    resolve(currentDir, '../../../native/ddudu-tui/target/debug/ddudu-tui'),
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  return null;
};

export const startNativeTui = async (): Promise<void> => {
  if (process.env.DDUDU_TUI === 'ink') {
    const configModule = await import('../../core/config.js');
    const config = await configModule.loadConfig();
    const { startInkTui } = await import('../ink/entry.js');
    await startInkTui(config);
    return;
  }

  const binaryPath = await resolveNativeBinary();
  if (!binaryPath) {
    const configModule = await import('../../core/config.js');
    const config = await configModule.loadConfig();
    const { startInkTui } = await import('../ink/entry.js');
    await startInkTui(config);
    return;
  }

  const bridgeEntrypoint = resolveBridgeEntrypoint();
  const child = spawn(
    binaryPath,
    ['--node', process.execPath, '--bridge', bridgeEntrypoint],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        DDUDU_TUI: 'native',
      },
    },
  );

  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolvePromise(code ?? 0));
  });

  process.exitCode = exitCode;
};
