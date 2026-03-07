import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

import type { Tool, ToolParameter, ToolResult } from './index.js';

interface ToolboxDescriptor {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
}

const DEFAULT_TOOLBOX_PATHS = ['~/.ddudu/tools/', '.ddudu/tools/'];

const expandHomePath = (rawPath: string): string => {
  if (rawPath.startsWith('~/')) {
    return resolve(homedir(), rawPath.slice(2));
  }

  return rawPath;
};

const resolveToolboxPaths = (): string[] => {
  const configured = process.env.DDUDU_TOOLBOX;
  const paths = configured && configured.trim().length > 0 ? configured.split(':') : DEFAULT_TOOLBOX_PATHS;

  return paths
    .map((pathItem) => pathItem.trim())
    .filter((pathItem) => pathItem.length > 0)
    .map((pathItem) => expandHomePath(pathItem))
    .map((pathItem) => resolve(process.cwd(), pathItem));
};

const isExecutable = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath, constants.X_OK);
    const fileStat = await stat(filePath);
    return fileStat.isFile() && (fileStat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

const runToolboxProcess = async (
  executablePath: string,
  action: 'describe' | 'execute',
  payload?: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; code: number }> => {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executablePath, [], {
      env: {
        ...process.env,
        TOOLBOX_ACTION: action,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err: Error) => {
      reject(err);
    });

    child.on('close', (code: number | null) => {
      resolvePromise({ stdout, stderr, code: code ?? 1 });
    });

    if (payload) {
      child.stdin.write(JSON.stringify(payload));
    }
    child.stdin.end();
  });
};

const parseTextDescriptor = (raw: string): ToolboxDescriptor | null => {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return null;
  }

  const result: Partial<ToolboxDescriptor> = {};

  for (const line of lines) {
    const match = line.match(/^([a-zA-Z_]+)\s*[:=]\s*(.+)$/);
    if (!match) {
      continue;
    }

    const key = match[1].toLowerCase();
    const value = match[2];

    if (key === 'name') {
      result.name = value;
      continue;
    }

    if (key === 'description') {
      result.description = value;
      continue;
    }

    if (key === 'params' || key === 'parameters') {
      try {
        result.parameters = JSON.parse(value) as Record<string, ToolParameter>;
      } catch {
        result.parameters = {};
      }
    }
  }

  if (!result.name || !result.description) {
    return null;
  }

  return {
    name: result.name,
    description: result.description,
    parameters: result.parameters ?? {},
  };
};

const parseDescriptor = (raw: string): ToolboxDescriptor | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      name?: unknown;
      description?: unknown;
      parameters?: unknown;
    };

    if (typeof parsed.name !== 'string' || typeof parsed.description !== 'string') {
      return null;
    }

    const parameters =
      typeof parsed.parameters === 'object' && parsed.parameters !== null
        ? (parsed.parameters as Record<string, ToolParameter>)
        : {};

    return {
      name: parsed.name,
      description: parsed.description,
      parameters,
    };
  } catch {
    return parseTextDescriptor(trimmed);
  }
};

const buildToolFromExecutable = (
  executablePath: string,
  descriptor: ToolboxDescriptor,
): Tool => {
  return {
    definition: {
      name: `tb__${descriptor.name}`,
      description: descriptor.description,
      parameters: descriptor.parameters,
    },
    async execute(args): Promise<ToolResult> {
      try {
        const result = await runToolboxProcess(executablePath, 'execute', args);
        if (result.code !== 0) {
          return {
            output: result.stderr.trim() || result.stdout.trim() || `Tool failed: ${descriptor.name}`,
            isError: true,
            metadata: { exitCode: result.code },
          };
        }

        return {
          output: result.stdout.trim(),
          metadata: { exitCode: result.code },
        };
      } catch (err: unknown) {
        return {
          output: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  };
};

export const discoverToolboxTools = async (): Promise<Tool[]> => {
  const tools: Tool[] = [];
  const directories = resolveToolboxPaths();

  for (const directory of directories) {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const executablePath = resolve(directory, entry.name);
      if (!(await isExecutable(executablePath))) {
        continue;
      }

      let describeResult: { stdout: string; stderr: string; code: number };
      try {
        describeResult = await runToolboxProcess(executablePath, 'describe');
      } catch {
        continue;
      }

      if (describeResult.code !== 0) {
        continue;
      }

      const descriptor = parseDescriptor(describeResult.stdout);
      if (!descriptor) {
        continue;
      }

      tools.push(buildToolFromExecutable(executablePath, descriptor));
    }
  }

  return tools;
};
