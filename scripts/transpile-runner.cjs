#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const ts = require('typescript');

// ts.sys may be undefined under Node.js v25+ ESM-interop CJS loading.
// Build a minimal polyfill from Node.js builtins so the script works regardless.
const sys = ts.sys ?? buildFallbackSys();

const projectRoot = process.cwd();
const srcRoot = path.join(projectRoot, 'src');
const distRoot = path.join(projectRoot, 'dist');
const buildNonce = `${process.pid}-${Date.now()}`;
const stagedDistRoot = path.join(projectRoot, `.dist-build-${buildNonce}`);
const previousDistRoot = path.join(projectRoot, `.dist-prev-${buildNonce}`);
const configPath = path.join(projectRoot, 'tsconfig.json');
const args = new Set(process.argv.slice(2));
const noEmit = args.has('--noEmit');

const configResult = ts.readConfigFile(configPath, sys.readFile);
if (configResult.error) {
  console.error(ts.formatDiagnosticsWithColorAndContext([configResult.error], formatHost()));
  process.exit(1);
}

const parsedConfig = ts.parseJsonConfigFileContent(
  configResult.config,
  sys,
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

if (!noEmit) {
  removeDirectory(stagedDistRoot);
  removeDirectory(previousDistRoot);
}

const diagnostics = [];
const sourceFiles = new Map();

for (const fileName of parsedConfig.fileNames) {
  const source = fs.readFileSync(fileName, 'utf8');
  sourceFiles.set(fileName, source);
  if (fileName.endsWith('.d.ts') || fileName.endsWith('.d.mts') || fileName.endsWith('.d.cts')) {
    continue;
  }

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
  const outFile = path.join(noEmit ? distRoot : stagedDistRoot, relativePath).replace(/\.ts$/, '.js');
  const outMap = `${outFile}.map`;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, output.outputText, 'utf8');
  if (output.sourceMapText) {
    fs.writeFileSync(outMap, output.sourceMapText, 'utf8');
  }
}

diagnostics.push(...validateLocalModuleContracts(sourceFiles));

const filteredDiagnostics = diagnostics.filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
);

if (filteredDiagnostics.length > 0) {
  if (!noEmit) {
    removeDirectory(stagedDistRoot);
    removeDirectory(previousDistRoot);
  }
  console.error(ts.formatDiagnosticsWithColorAndContext(filteredDiagnostics, formatHost()));
  process.exit(1);
}

if (!noEmit) {
  copyStaticFiles(srcRoot, stagedDistRoot);
  replaceDirectoryAtomically(stagedDistRoot, distRoot, previousDistRoot);
  const entryPoint = path.join(distRoot, 'index.js');
  if (fs.existsSync(entryPoint)) {
    fs.chmodSync(entryPoint, 0o755);
  }
}

process.exit(0);

function formatHost() {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => projectRoot,
    getNewLine: () => sys.newLine,
  };
}

function buildFallbackSys() {
  const isCaseSensitive = process.platform !== 'win32' && process.platform !== 'darwin';
  const readFile = (filePath) => {
    try { return fs.readFileSync(filePath, 'utf8'); }
    catch { return undefined; }
  };
  const fileExists = (filePath) => {
    try { fs.accessSync(filePath, fs.constants.R_OK); return true; }
    catch { return false; }
  };
  const directoryExists = (dirPath) => {
    try { return fs.statSync(dirPath).isDirectory(); }
    catch { return false; }
  };
  const getDirectories = (dirPath) => {
    try {
      return fs.readdirSync(dirPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch { return []; }
  };
  const readDirectory = (rootDir, extensions, excludes, _includes, depth) => {
    const results = [];
    const extSet = new Set(extensions || []);
    const excludeSet = new Set(excludes || []);
    const maxDepth = typeof depth === 'number' ? depth : 64;
    const walk = (dir, currentDepth) => {
      if (currentDepth > maxDepth) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (excludeSet.has(entry.name)) continue;
          walk(full, currentDepth + 1);
        } else if (entry.isFile()) {
          if (extSet.size === 0 || Array.from(extSet).some((ext) => entry.name.endsWith(ext))) {
            results.push(full);
          }
        }
      }
    };
    walk(rootDir, 0);
    return results;
  };
  return {
    readFile,
    fileExists,
    directoryExists,
    getDirectories,
    readDirectory,
    useCaseSensitiveFileNames: isCaseSensitive,
    newLine: '\n',
    getCurrentDirectory: () => process.cwd(),
    write: (text) => process.stdout.write(text),
    exit: (code) => process.exit(code),
  };
}

function buildFallbackSys() {
  const isCaseSensitive = process.platform !== 'win32' && process.platform !== 'darwin';
  const readFile = (filePath) => {
    try { return fs.readFileSync(filePath, 'utf8'); }
    catch { return undefined; }
  };
  const fileExists = (filePath) => {
    try { fs.accessSync(filePath, fs.constants.R_OK); return true; }
    catch { return false; }
  };
  const directoryExists = (dirPath) => {
    try { return fs.statSync(dirPath).isDirectory(); }
    catch { return false; }
  };
  const getDirectories = (dirPath) => {
    try {
      return fs.readdirSync(dirPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch { return []; }
  };
  const readDirectory = (rootDir, extensions, excludes, _includes, depth) => {
    const results = [];
    const extSet = new Set(extensions || []);
    const excludeSet = new Set(excludes || []);
    const maxDepth = typeof depth === 'number' ? depth : 64;
    const walk = (dir, currentDepth) => {
      if (currentDepth > maxDepth) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (excludeSet.has(entry.name)) continue;
          walk(full, currentDepth + 1);
        } else if (entry.isFile()) {
          if (extSet.size === 0 || Array.from(extSet).some((ext) => entry.name.endsWith(ext))) {
            results.push(full);
          }
        }
      }
    };
    walk(rootDir, 0);
    return results;
  };
  return {
    readFile,
    fileExists,
    directoryExists,
    getDirectories,
    readDirectory,
    useCaseSensitiveFileNames: isCaseSensitive,
    newLine: '\n',
    getCurrentDirectory: () => process.cwd(),
    write: (text) => process.stdout.write(text),
    exit: (code) => process.exit(code),
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

function replaceDirectoryAtomically(nextDir, targetDir, backupDir) {
  removeDirectory(backupDir);

  if (fs.existsSync(targetDir)) {
    fs.renameSync(targetDir, backupDir);
  }

  try {
    fs.renameSync(nextDir, targetDir);
  } catch (error) {
    if (fs.existsSync(backupDir) && !fs.existsSync(targetDir)) {
      fs.renameSync(backupDir, targetDir);
    }
    throw error;
  }

  try {
    removeDirectory(backupDir);
  } catch (error) {
    console.warn(`Warning: failed to remove backup dist directory '${backupDir}': ${error.message}`);
  }
}

function removeDirectory(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  const retryableCodes = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
      return;
    } catch (error) {
      if (!retryableCodes.has(error.code) || attempt === 5) {
        throw error;
      }
      waitMs(50 * (attempt + 1));
    }
  }
}

function waitMs(durationMs) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sleeper, 0, 0, durationMs);
}

function validateLocalModuleContracts(sourceFiles) {
  const diagnostics = [];
  const exportMap = new Map();
  const normalizedFiles = Array.from(sourceFiles.keys());

  for (const [fileName, source] of sourceFiles.entries()) {
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    exportMap.set(fileName, collectExports(sourceFile));
  }

  for (const [fileName, source] of sourceFiles.entries()) {
    const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }

      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.')) {
        continue;
      }

      const resolved = resolveLocalModule(fileName, specifier, normalizedFiles);
      if (!resolved) {
        diagnostics.push(makeDiagnostic(fileName, statement.moduleSpecifier, `Cannot resolve local module '${specifier}'.`));
        continue;
      }

      const exports = exportMap.get(resolved);
      if (!exports) {
        diagnostics.push(makeDiagnostic(fileName, statement.moduleSpecifier, `No export metadata available for '${specifier}'.`));
        continue;
      }

      const clause = statement.importClause;
      if (!clause) {
        continue;
      }

      if (clause.name && !exports.default) {
        diagnostics.push(makeDiagnostic(fileName, clause.name, `Module '${specifier}' has no default export.`));
      }

      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const importedName = (element.propertyName ?? element.name).text;
          if (!exports.named.has(importedName)) {
            diagnostics.push(
              makeDiagnostic(
                fileName,
                element,
                `Module '${specifier}' has no exported member '${importedName}'.`,
              ),
            );
          }
        }
      }
    }
  }

  return diagnostics;
}

function collectExports(sourceFile) {
  const named = new Set();
  let defaultExport = false;

  for (const statement of sourceFile.statements) {
    if (hasExportModifier(statement)) {
      if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
        defaultExport = true;
      }

      if (statement.name && ts.isIdentifier(statement.name)) {
        named.add(statement.name.text);
      }

      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            named.add(declaration.name.text);
          }
        }
      }
    }

    if (ts.isExportAssignment(statement)) {
      defaultExport = true;
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        named.add(element.name.text);
      }
    }
  }

  return {
    named,
    default: defaultExport,
  };
}

function hasExportModifier(statement) {
  return Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function resolveLocalModule(fromFile, specifier, fileNames) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    `${base}.d.mts`,
    `${base}.d.cts`,
    base.replace(/\.js$/i, '.ts'),
    base.replace(/\.js$/i, '.tsx'),
    base.replace(/\.mjs$/i, '.d.mts'),
    base.replace(/\.cjs$/i, '.d.cts'),
    base.replace(/\.js$/i, '.d.ts'),
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.d.ts'),
    path.join(base.replace(/\.js$/i, ''), 'index.ts'),
    path.join(base.replace(/\.js$/i, ''), 'index.tsx'),
    path.join(base.replace(/\.js$/i, ''), 'index.d.ts'),
  ];

  return candidates.find((candidate) => fileNames.includes(candidate)) ?? null;
}

function makeDiagnostic(fileName, node, messageText) {
  return {
    category: ts.DiagnosticCategory.Error,
    code: 9001,
    file: ts.createSourceFile(fileName, fs.readFileSync(fileName, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS),
    start: node.getStart(),
    length: node.getWidth(),
    messageText,
  };
}
