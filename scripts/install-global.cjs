#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { existsSync, rmSync } = require('node:fs');
const path = require('node:path');

const projectRoot = process.cwd();
const packageJsonPath = path.join(projectRoot, 'package.json');
// eslint-disable-next-line import/no-dynamic-require, global-require
const packageJson = require(packageJsonPath);
const packageName = packageJson.name;

let tarballPath = null;

try {
  const packOutput = execFileSync('npm', ['pack', '--json', '--silent'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  const packResult = parsePackResult(packOutput);
  const tarballName = packResult[0]?.filename;
  if (!tarballName) {
    throw new Error('npm pack did not return a tarball filename.');
  }

  tarballPath = path.join(projectRoot, tarballName);

  try {
    execFileSync('npm', ['uninstall', '-g', packageName], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
  } catch {
    // Ignore missing global installs.
  }

  execFileSync('npm', ['install', '-g', tarballPath], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
} finally {
  if (tarballPath && existsSync(tarballPath)) {
    rmSync(tarballPath, { force: true });
  }
}

function parsePackResult(output) {
  try {
    return JSON.parse(output);
  } catch {
    const match = output.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/);
    if (!match) {
      throw new Error('Failed to parse npm pack output.');
    }
    return JSON.parse(match[1]);
  }
}
