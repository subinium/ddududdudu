#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const ts = require('typescript');

const projectRoot = process.cwd();
const srcRoot = path.join(projectRoot, 'src');
const distRoot = path.join(projectRoot, 'dist');
const configPath = path.join(projectRoot, 'tsconfig.json');
const args = new Set(process.argv.slice(2));
const noEmit = args.has('--noEmit');

const configResult = ts.readConfigFile(configPath, ts.sys.readFile);
if (configResult.error) {
  console.error(ts.formatDiagnosticsWithColorAndContext([configResult.error], formatHost()));
  process.exit(1);
}

const parsedConfig = ts.parseJsonConfigFileContent(
  configResult.config,
  ts.sys,
  projectRoot,
  {},
  configPath,
);

if (parsedConfig.errors.length > 0) {
  console.error(ts.formatDiagnosticsWithColorAndContext(parsedConfig.errors, formatHost()));
  process.exit(1);
}

const compilerOptions = {
  ...parsedConfig.options,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  sourceMap: true,
  inlineSources: false,
  declaration: false,
  declarationMap: false,
};

const diagnostics = [];

if (!noEmit) {
  fs.rmSync(distRoot, { recursive: true, force: true });
}

for (const fileName of parsedConfig.fileNames) {
  const source = fs.readFileSync(fileName, 'utf8');
  const transpileFileName = fileName.replace(/\.ts$/, '.mts');
  const output = ts.transpileModule(source, {
    compilerOptions,
    fileName: transpileFileName,
    reportDiagnostics: true,
  });

  if (output.diagnostics?.length) {
    diagnostics.push(...output.diagnostics);
  }

  if (noEmit) {
    continue;
  }

  const relativePath = path.relative(srcRoot, fileName);
  const outFile = path.join(distRoot, relativePath).replace(/\.ts$/, '.js');
  const outMap = `${outFile}.map`;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, output.outputText, 'utf8');
  if (output.sourceMapText) {
    fs.writeFileSync(outMap, output.sourceMapText, 'utf8');
  }
}

copyStaticFiles(srcRoot, distRoot);

const filteredDiagnostics = diagnostics.filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
);

if (filteredDiagnostics.length > 0) {
  console.error(ts.formatDiagnosticsWithColorAndContext(filteredDiagnostics, formatHost()));
  process.exit(1);
}

process.exit(0);

function formatHost() {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => projectRoot,
    getNewLine: () => ts.sys.newLine,
  };
}

function copyStaticFiles(fromDir, toDir) {
  const entries = fs.readdirSync(fromDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(fromDir, entry.name);
    const targetPath = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      copyStaticFiles(sourcePath, targetPath);
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      continue;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}
