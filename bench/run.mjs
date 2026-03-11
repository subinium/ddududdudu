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

const runWithConcurrency = async (tasks, maxConcurrency, runner) => {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = runner(task).then((result) => {
      executing.delete(p);
      return result;
    });
    executing.add(p);
    results.push(p);
    if (executing.size >= maxConcurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.allSettled(results);
};

const emptyResult = {
  code: null,
  signal: null,
  timedOut: false,
  stdout: '',
  stderr: '',
  durationMs: 0,
};

const parseNumber = (value) => {
  if (!value) {
    return null;
  }

  const normalized = value.replaceAll(',', '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseCost = (stdout, stderr) => {
  const merged = `${stdout}\n${stderr}`;

  const tokenMatch = merged.match(/tokens\s*:\s*([\d,]+)\s*input\s*,\s*([\d,]+)\s*output/i);
  const inputTokens = tokenMatch ? parseNumber(tokenMatch[1]) : null;
  const outputTokens = tokenMatch ? parseNumber(tokenMatch[2]) : null;

  const usdMatch = merged.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  const estimatedUsd = usdMatch ? Number(usdMatch[1]) : null;

  return {
    inputTokens,
    outputTokens,
    estimatedUsd: Number.isFinite(estimatedUsd) ? estimatedUsd : null,
  };
};

const classifyFailureMode = ({ setupResult, runResult, verifyResult }) => {
  if (runResult.code === 0 && verifyResult.code === 0 && !runResult.timedOut && !verifyResult.timedOut) {
    return null;
  }

  if (runResult.timedOut || verifyResult.timedOut || setupResult?.timedOut) {
    return 'timeout';
  }

  if (setupResult && setupResult.code !== 0) {
    return 'setup-failed';
  }

  if ((typeof runResult.code === 'number' && runResult.code > 128) || (typeof verifyResult.code === 'number' && verifyResult.code > 128)) {
    return 'crash';
  }

  if (runResult.code === 0 && verifyResult.code !== 0) {
    return 'verification-failed';
  }

  if (runResult.code === 1) {
    return 'wrong-output';
  }

  return 'crash';
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const tasksPath = resolve(args.tasks || 'bench/tasks.example.yaml');
  const outPath = resolve(args.out || `bench/results/run-${Date.now()}.jsonl`);
  const commandTemplate = args['command-template'];
  const setupCommand = args['setup-command'] || '';
  const concurrency = Math.max(1, Number.parseInt(String(args.concurrency || '3'), 10) || 3);
  const resume = args.resume === 'true';
  const models = String(args.models || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const selectedModels = models.length > 0 ? models : [null];
  const only = args.only ? new Set(String(args.only).split(',').map((item) => item.trim()).filter(Boolean)) : null;

  if (!commandTemplate) {
    throw new Error('Missing --command-template. Example: --command-template \'ddudu run "{prompt}"\'');
  }

  const raw = await readFile(tasksPath, 'utf8');
  const parsed = YAML.parse(raw);
  const tasks = Array.isArray(parsed) ? parsed : [];
  const filteredTasks = only ? tasks.filter((task) => only.has(task.id)) : tasks;
  const expandedTasks = filteredTasks.flatMap((task) => selectedModels.map((model) => ({ task, model })));

  await mkdir(dirname(outPath), { recursive: true });

  const completed = new Set();
  if (resume) {
    try {
      const existingRaw = await readFile(outPath, 'utf8');
      for (const line of existingRaw.split('\n').map((item) => item.trim()).filter(Boolean)) {
        const row = JSON.parse(line);
        const key = `${String(row.id)}::${row.model ?? ''}`;
        completed.add(key);
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  let writeQueue = Promise.resolve();
  const appendRecord = async (record) => {
    writeQueue = writeQueue.then(() => writeFile(outPath, `${JSON.stringify(record)}\n`, { flag: 'a' }));
    await writeQueue;
  };

  let startedCount = 0;
  const runnable = expandedTasks.filter(({ task, model }) => {
    const key = `${String(task.id)}::${model ?? ''}`;
    if (!resume || !completed.has(key)) {
      return true;
    }
    const taskLabel = model ? `${task.id} (${model})` : task.id;
    process.stdout.write(`SKIP ${taskLabel} (already completed)\n`);
    return false;
  });
  const totalPlanned = expandedTasks.length;

  await runWithConcurrency(runnable, concurrency, async ({ task, model }) => {
    startedCount += 1;
    const progress = `[${startedCount}/${totalPlanned}]`;
    const taskLabel = model ? `${task.id} (${model})` : task.id;
    process.stdout.write(`${progress} RUNNING ${taskLabel}...\n`);

    const repoPath = resolve(String(task.repo));
    const prompt = String(task.prompt || '');
    const command = commandTemplate
      .replaceAll('{prompt}', prompt.replaceAll('"', '\\"'))
      .replaceAll('{model}', model || '');
    const successCommand = String(task.success_command || '');

    const startedAt = Date.now();
    let runRoot = null;
    let workspace = null;

    let setupResult = null;
    let runResult = { ...emptyResult, code: 1 };
    let verifyResult = { ...emptyResult, code: 1 };

    try {
      runRoot = await mkdtemp(resolve(tmpdir(), `ddudu-bench-${task.id}-`));
      workspace = resolve(runRoot, basename(repoPath));
      await cp(repoPath, workspace, { recursive: true });

      if (setupCommand) {
        setupResult = await runShellCommand(setupCommand, workspace, 10 * 60_000);
      }

      const timeoutMinutes = Number(task.timeout_minutes || 20);
      runResult = setupResult && setupResult.code !== 0
        ? { ...emptyResult, code: 1, stderr: `setup command failed with code ${setupResult.code}` }
        : await runShellCommand(command, workspace, timeoutMinutes * 60_000);
      verifyResult = successCommand && runResult.code === 0 && !runResult.timedOut
        ? await runShellCommand(successCommand, workspace, timeoutMinutes * 60_000)
        : { ...emptyResult, code: runResult.code === 0 ? 0 : 1 };
    } catch (error) {
      runResult = {
        ...emptyResult,
        code: 129,
        stderr: error instanceof Error ? error.message : String(error),
      };
      verifyResult = { ...emptyResult, code: 1 };
    } finally {
      const finishedAt = Date.now();
      const failureMode = classifyFailureMode({ setupResult, runResult, verifyResult });
      const cost = parseCost(
        [setupResult?.stdout || '', runResult.stdout, verifyResult.stdout].join('\n'),
        [setupResult?.stderr || '', runResult.stderr, verifyResult.stderr].join('\n'),
      );
      const record = {
        id: task.id,
        difficulty: task.difficulty ?? null,
        repo: repoPath,
        workspace,
        prompt,
        model,
        command,
        successCommand: successCommand || null,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        success: failureMode === null,
        failureMode,
        cost,
        setup: setupResult
          ? {
              code: setupResult.code,
              signal: setupResult.signal,
              timedOut: setupResult.timedOut,
              durationMs: setupResult.durationMs,
              stdout: clip(setupResult.stdout),
              stderr: clip(setupResult.stderr),
            }
          : null,
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

      await appendRecord(record);
      process.stdout.write(`${record.success ? 'PASS' : 'FAIL'} ${taskLabel} ${record.durationMs}ms\n`);

      if (runRoot) {
        await rm(runRoot, { recursive: true, force: true });
      }
    }
  });

  process.stdout.write(`\nWrote results to ${outPath}\n`);
};

main().catch((error) => {
  process.stderr.write(`bench: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
