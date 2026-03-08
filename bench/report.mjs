import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

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

  process.stdout.write(`Runs: ${rows.length}\n`);
  process.stdout.write(`Pass rate: ${passed}/${rows.length} (${Math.round((passed / rows.length) * 100)}%)\n`);
  process.stdout.write(`Average duration: ${averageDuration}ms\n\n`);
  process.stdout.write('Per task:\n');

  for (const row of rows) {
    process.stdout.write(
      `- ${row.id}: ${row.success ? 'PASS' : 'FAIL'} · ${row.durationMs}ms · run=${row.run.code} verify=${row.verify.code}\n`,
    );
  }
};

main().catch((error) => {
  process.stderr.write(`bench report: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
