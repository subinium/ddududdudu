import { execFile, spawn } from 'node:child_process';
import { access, constants, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 96 * 1024;
const DEFAULT_SCRIPT_CANDIDATES = {
  lint: ['lint', 'typecheck', 'check'],
  test: ['test', 'check', 'ci:test'],
  build: ['build', 'compile'],
} as const;

interface PackageJsonLike {
  scripts?: Record<string, unknown>;
}

export interface StructuredRunnerResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  summary: string;
  highlights: string[];
}

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const preview = (value: string, maxLength: number = 200): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const truncateUtf8 = (text: string, maxBytes: number): { text: string; truncated: boolean } => {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }

  const sliced = encoded.subarray(0, maxBytes).toString('utf8');
  return {
    text: `${sliced.trimEnd()}\n\n[truncated]`,
    truncated: true,
  };
};

export const detectPackageManager = async (
  cwd: string,
): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> => {
  if (await exists(resolve(cwd, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (await exists(resolve(cwd, 'yarn.lock'))) {
    return 'yarn';
  }
  if (await exists(resolve(cwd, 'bun.lockb')) || await exists(resolve(cwd, 'bun.lock'))) {
    return 'bun';
  }

  return 'npm';
};

export const readPackageScripts = async (cwd: string): Promise<Record<string, string>> => {
  const packageJsonPath = resolve(cwd, 'package.json');
  if (!(await exists(packageJsonPath))) {
    return {};
  }

  try {
    const raw = await readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as PackageJsonLike;
    const scripts = parsed.scripts ?? {};
    return Object.fromEntries(
      Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
};

export const resolveScriptName = async (
  cwd: string,
  explicit: unknown,
  fallback: readonly string[],
): Promise<string | null> => {
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit.trim();
  }

  const scripts = await readPackageScripts(cwd);
  for (const candidate of fallback) {
    if (scripts[candidate]?.trim()) {
      return candidate;
    }
  }

  return null;
};

export const collectHighlights = (output: string, maxHighlights: number = 6): string[] => {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const interesting = lines.filter((line) =>
    /\b(error|errors|failed|fail|failing|exception|warning|warnings|not ok|cannot|undefined|traceback)\b/i.test(line),
  );

  const pool = interesting.length > 0 ? interesting : lines;
  return pool.slice(0, maxHighlights).map((line) => preview(line, 180));
};

export const summarizeStructuredOutput = (
  kind: 'lint' | 'test' | 'build',
  ok: boolean,
  output: string,
): string => {
  const highlights = collectHighlights(output, 2);
  const prefix = ok ? `${kind} passed` : `${kind} failed`;
  if (highlights.length === 0) {
    return prefix;
  }

  return `${prefix} · ${highlights.join(' · ')}`;
};

export const runStructuredVerifierCommand = async (
  cwd: string,
  input: {
    kind: 'lint' | 'test' | 'build';
    command?: unknown;
    script?: unknown;
    timeoutMs?: unknown;
  },
): Promise<StructuredRunnerResult> => {
  const timeoutMs =
    typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
      ? Math.max(1_000, Math.min(600_000, Math.floor(input.timeoutMs)))
      : DEFAULT_TIMEOUT_MS;

  if (typeof input.command === 'string' && input.command.trim().length > 0) {
    const command = input.command.trim();
    return new Promise((resolveResult) => {
      const child = spawn('bash', ['-lc', command], {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let finished = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('close', (code, signal) => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        const combined = [stdout, stderr].filter(Boolean).join('\n');
        const effective = timedOut
          ? `${combined}\n\n[timeout after ${timeoutMs}ms]`.trim()
          : combined;
        const truncated = truncateUtf8(effective, MAX_OUTPUT_BYTES);
        resolveResult({
          ok: code === 0 && !timedOut,
          command,
          exitCode: signal ? null : code,
          output: truncated.text,
          truncated: truncated.truncated,
          summary: summarizeStructuredOutput(input.kind, code === 0 && !timedOut, effective),
          highlights: collectHighlights(effective),
        });
      });
    });
  }

  const script = await resolveScriptName(cwd, input.script, DEFAULT_SCRIPT_CANDIDATES[input.kind]);
  if (!script) {
    return {
      ok: false,
      command: `${input.kind} script`,
      exitCode: null,
      output: `No ${input.kind} script found in package.json and no explicit command was provided.`,
      truncated: false,
      summary: `${input.kind} script missing`,
      highlights: [],
    };
  }

  const packageManager = await detectPackageManager(cwd);
  const args =
    packageManager === 'npm'
      ? ['run', '--silent', script]
      : packageManager === 'pnpm'
        ? ['run', '--silent', script]
        : packageManager === 'yarn'
          ? [script, '--silent']
          : ['run', script];

  try {
    const result = await execFileAsync(packageManager, args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const truncated = truncateUtf8(output || `${script} passed`, MAX_OUTPUT_BYTES);
    return {
      ok: true,
      command: `${packageManager} ${args.join(' ')}`,
      exitCode: 0,
      output: truncated.text,
      truncated: truncated.truncated,
      summary: summarizeStructuredOutput(input.kind, true, output || `${script} passed`),
      highlights: collectHighlights(output),
    };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; code?: number | null; message?: string };
    const output = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
    const truncated = truncateUtf8(output || `${script} failed`, MAX_OUTPUT_BYTES);
    return {
      ok: false,
      command: `${packageManager} ${args.join(' ')}`,
      exitCode: typeof err.code === 'number' ? err.code : null,
      output: truncated.text,
      truncated: truncated.truncated,
      summary: summarizeStructuredOutput(input.kind, false, output || `${script} failed`),
      highlights: collectHighlights(output),
    };
  }
};
