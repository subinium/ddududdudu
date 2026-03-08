import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, resolve } from 'node:path';

import { getDduduPaths } from './dirs.js';
import { type HookContext, type HookEvent, type HookRegistry } from './hooks.js';

const HOOK_EVENTS: HookEvent[] = [
  'beforeToolCall',
  'afterToolCall',
  'beforeApiCall',
  'afterApiCall',
  'onSessionStart',
  'onSessionEnd',
  'onModeSwitch',
  'onError',
  'beforeSend',
  'afterResponse',
];

const resolveHookCommand = async (filePath: string): Promise<{ command: string; args: string[] } | null> => {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.sh') {
    return { command: 'sh', args: [filePath] };
  }

  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    return { command: process.execPath, args: [filePath] };
  }

  try {
    await access(filePath, constants.X_OK);
    return { command: filePath, args: [] };
  } catch {
    return null;
  }
};

const createHookHandler = (filePath: string) => {
  return async (context: HookContext): Promise<void> => {
    const command = await resolveHookCommand(filePath);
    if (!command) {
      throw new Error(`Unsupported hook file: ${filePath}`);
    }

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(command.command, command.args, {
        env: {
          ...process.env,
          DDUDU_HOOK_EVENT: context.event,
          DDUDU_HOOK_TIMESTAMP: String(context.timestamp),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('error', (error: Error) => {
        rejectPromise(error);
      });

      child.on('close', (code: number | null) => {
        if ((code ?? 0) === 0) {
          resolvePromise();
          return;
        }

        const suffix = stderr.trim() ? ` ${stderr.trim()}` : '';
        rejectPromise(new Error(`Hook failed: ${filePath} exited with ${code ?? 0}.${suffix}`));
      });

      child.stdin.end(JSON.stringify(context));
    });
  };
};

const collectHookFiles = async (directory: string): Promise<Array<{ event: HookEvent; filePath: string }>> => {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .flatMap((entry) => {
        const filePath = resolve(directory, entry.name);
        const matchedEvent = HOOK_EVENTS.find((event) => {
          return entry.name === event || entry.name.startsWith(`${event}.`) || entry.name.startsWith(`${event}-`);
        });

        return matchedEvent ? [{ event: matchedEvent, filePath }] : [];
      })
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
  } catch {
    return [];
  }
};

export const loadHookFiles = async (
  cwd: string,
  hookRegistry: HookRegistry,
): Promise<Array<{ event: HookEvent; filePath: string }>> => {
  const paths = getDduduPaths(cwd);
  const [globalHooks, projectHooks] = await Promise.all([
    collectHookFiles(paths.globalHooks),
    collectHookFiles(paths.projectHooks),
  ]);

  const discovered = [...globalHooks, ...projectHooks];
  for (const hook of discovered) {
    hookRegistry.on(hook.event, createHookHandler(hook.filePath));
  }

  return discovered;
};
