#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { spawnSync } = require('node:child_process');

const projectRoot = process.cwd();
const testDir = path.join(projectRoot, 'test');
const files = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith('.test.mjs'))
  .sort();

let failed = 0;

for (const file of files) {
  const relativeFile = path.join('test', file);
  process.stdout.write(`\n[tests] ${relativeFile}\n`);
  const result = spawnSync(process.execPath, ['--test', relativeFile], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`\n[tests] ${failed} file(s) failed`);
  process.exit(1);
}

console.log(`\n[tests] ${files.length} file(s) passed`);
