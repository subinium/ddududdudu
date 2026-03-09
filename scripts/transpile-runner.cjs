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

if (!noEmit) {
  fs.rmSync(distRoot, { recursive: true, force: true });
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
  const outFile = path.join(distRoot, relativePath).replace(/\.ts$/, '.js');
  const outMap = `${outFile}.map`;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, output.outputText, 'utf8');
  if (output.sourceMapText) {
    fs.writeFileSync(outMap, output.sourceMapText, 'utf8');
  }
}

diagnostics.push(...validateLocalModuleContracts(sourceFiles));

if (!noEmit) {
  copyStaticFiles(srcRoot, distRoot);
}

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
