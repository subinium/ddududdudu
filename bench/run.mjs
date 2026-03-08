import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

import YAML from 'yaml';

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
      continue;
    }

    options[key] = 'true';
  }

  return options;
};

const runShellCommand = async (command, cwd, timeoutMs) => {
  const startedAt = Date.now();
  return await new Promise((resolvePromise) => {
    const proc = spawn(process.env.SHELL || 'zsh', ['-lc', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        code: code ?? 0,
        signal,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
};

const clip = (value, max = 1200) => {
  const normalized = value.trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max).trimEnd()}…`;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const tasksPath = resolve(args.tasks || 'bench/tasks.example.yaml');
  const outPath = resolve(args.out || `bench/results/run-${Date.now()}.jsonl`);
  const commandTemplate = args['command-template'];
  const setupCommand = args['setup-command'] || '';
  const only = args.only ? new Set(String(args.only).split(',').map((item) => item.trim()).filter(Boolean)) : null;

  if (!commandTemplate) {
    throw new Error('Missing --command-template. Example: --command-template \'ddudu run "{prompt}"\'');
  }

  const raw = await readFile(tasksPath, 'utf8');
  const parsed = YAML.parse(raw);
  const tasks = Array.isArray(parsed) ? parsed : [];
  const filteredTasks = only ? tasks.filter((task) => only.has(task.id)) : tasks;

  await mkdir(dirname(outPath), { recursive: true });

  for (const task of filteredTasks) {
    const repoPath = resolve(String(task.repo));
    const runRoot = await mkdtemp(resolve(tmpdir(), `ddudu-bench-${task.id}-`));
    const workspace = resolve(runRoot, basename(repoPath));
    await cp(repoPath, workspace, { recursive: true });

    try {
      if (setupCommand) {
        await runShellCommand(setupCommand, workspace, 10 * 60_000);
      }

      const timeoutMinutes = Number(task.timeout_minutes || 20);
      const prompt = String(task.prompt || '');
      const command = commandTemplate.replaceAll('{prompt}', prompt.replaceAll('"', '\\"'));
      const successCommand = String(task.success_command || '');

      const startedAt = Date.now();
      const runResult = await runShellCommand(command, workspace, timeoutMinutes * 60_000);
      const verifyResult = successCommand
        ? await runShellCommand(successCommand, workspace, timeoutMinutes * 60_000)
        : { code: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 0 };
      const finishedAt = Date.now();

      const record = {
        id: task.id,
        difficulty: task.difficulty ?? null,
        repo: repoPath,
        workspace,
        prompt,
        command,
        successCommand: successCommand || null,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        success: runResult.code === 0 && verifyResult.code === 0 && !runResult.timedOut && !verifyResult.timedOut,
        run: {
          code: runResult.code,
          signal: runResult.signal,
          timedOut: runResult.timedOut,
          durationMs: runResult.durationMs,
          stdout: clip(runResult.stdout),
          stderr: clip(runResult.stderr),
        },
        verify: {
          code: verifyResult.code,
          signal: verifyResult.signal,
          timedOut: verifyResult.timedOut,
          durationMs: verifyResult.durationMs,
          stdout: clip(verifyResult.stdout),
          stderr: clip(verifyResult.stderr),
        },
      };

      await writeFile(outPath, `${JSON.stringify(record)}\n`, { flag: 'a' });
      process.stdout.write(`${record.success ? 'PASS' : 'FAIL'} ${task.id} ${record.durationMs}ms\n`);
    } finally {
      await rm(runRoot, { recursive: true, force: true });
    }
  }

  process.stdout.write(`\nWrote results to ${outPath}\n`);
};

main().catch((error) => {
  process.stderr.write(`bench: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
