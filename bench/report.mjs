import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const labelOrDefault = (value, fallback) => {
  if (value === null || value === undefined) {
    return fallback;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : fallback;
};

const formatPercent = (part, total) => {
  if (!total) {
    return '0%';
  }
  return `${Math.round((part / total) * 100)}%`;
};

const formatUsd = (value) => {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  return `$${value.toFixed(4)}`;
};

const renderTable = (headers, rows) => {
  if (rows.length === 0) {
    return '';
  }

  const widths = headers.map((header, index) => {
    const values = rows.map((row) => String(row[index] ?? ''));
    return Math.max(String(header).length, ...values.map((value) => value.length));
  });

  const padRow = (row) => row.map((cell, index) => String(cell ?? '').padEnd(widths[index], ' ')).join('  ');
  const separator = widths.map((width) => '-'.repeat(width)).join('  ');

  return [padRow(headers), separator, ...rows.map((row) => padRow(row))].join('\n');
};

const main = async () => {
  const filePath = resolve(process.argv[2] || '');
  if (!process.argv[2]) {
    throw new Error('Usage: node bench/report.mjs <results.jsonl>');
  }

  const raw = await readFile(filePath, 'utf8');
  const rows = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  if (rows.length === 0) {
    process.stdout.write('No benchmark rows found.\n');
    return;
  }

  const passed = rows.filter((row) => row.success).length;
  const averageDuration = Math.round(rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length);
  const difficulties = new Map();
  const failureModes = new Map();
  const modelStats = new Map();

  let totalCost = 0;
  let parsableCostRows = 0;

  for (const row of rows) {
    const difficulty = labelOrDefault(row.difficulty, 'unknown');
    const difficultyBucket = difficulties.get(difficulty) || { total: 0, passed: 0 };
    difficultyBucket.total += 1;
    if (row.success) {
      difficultyBucket.passed += 1;
    }
    difficulties.set(difficulty, difficultyBucket);

    const mode = labelOrDefault(row.failureMode, 'success');
    failureModes.set(mode, (failureModes.get(mode) || 0) + 1);

    const model = labelOrDefault(row.model, 'default');
    const modelBucket = modelStats.get(model) || { total: 0, passed: 0 };
    modelBucket.total += 1;
    if (row.success) {
      modelBucket.passed += 1;
    }
    modelStats.set(model, modelBucket);

    const cost = row?.cost?.estimatedUsd;
    if (Number.isFinite(cost)) {
      totalCost += cost;
      parsableCostRows += 1;
    }
  }

  const averageCostPerTask = rows.length > 0 ? totalCost / rows.length : 0;

  process.stdout.write(`Runs: ${rows.length}\n`);
  process.stdout.write(`Pass rate: ${passed}/${rows.length} (${Math.round((passed / rows.length) * 100)}%)\n`);
  process.stdout.write(`Average duration: ${averageDuration}ms\n`);
  process.stdout.write(`Total estimated cost: ${formatUsd(totalCost)} (${parsableCostRows}/${rows.length} runs parseable)\n`);
  process.stdout.write(`Average estimated cost per task: ${formatUsd(averageCostPerTask)}\n\n`);

  const difficultyRows = [...difficulties.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([difficulty, stats]) => [
      difficulty,
      String(stats.total),
      `${stats.passed}/${stats.total}`,
      formatPercent(stats.passed, stats.total),
    ]);
  process.stdout.write('Per difficulty:\n');
  process.stdout.write(`${renderTable(['difficulty', 'runs', 'passes', 'passRate'], difficultyRows)}\n\n`);

  const failureRows = [...failureModes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mode, count]) => [mode, String(count)]);
  process.stdout.write('Failure modes:\n');
  process.stdout.write(`${renderTable(['failureMode', 'count'], failureRows)}\n\n`);

  if (modelStats.size > 1) {
    const modelRows = [...modelStats.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, stats]) => [model, String(stats.total), `${stats.passed}/${stats.total}`, formatPercent(stats.passed, stats.total)]);
    process.stdout.write('Model comparison:\n');
    process.stdout.write(`${renderTable(['model', 'runs', 'passes', 'passRate'], modelRows)}\n\n`);
  }

  const perTaskRows = rows
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((row) => [
      row.id,
      labelOrDefault(row.model, 'default'),
      row.success ? 'PASS' : 'FAIL',
      `${row.durationMs}ms`,
      `run=${row.run?.code ?? 'n/a'}`,
      `verify=${row.verify?.code ?? 'n/a'}`,
      labelOrDefault(row.failureMode, 'success'),
      formatUsd(Number.isFinite(row?.cost?.estimatedUsd) ? row.cost.estimatedUsd : NaN),
    ]);
  process.stdout.write('Per task:\n');
  process.stdout.write(`${renderTable(['id', 'model', 'status', 'duration', 'run', 'verify', 'failureMode', 'cost'], perTaskRows)}\n`);
};

main().catch((error) => {
  process.stderr.write(`bench report: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
