import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { SessionBriefing } from './briefing.js';

export interface DriftReport {
  staleFiles: string[];
  modifiedFiles: string[];
  validClaims: number;
  staleClaims: number;
  timestamp: string;
}

const execFileAsync = promisify(execFile);
const SEARCH_EXTENSIONS = new Set<string>(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const toUniqueSorted = (items: string[]): string[] => {
  return Array.from(
    new Set(items.map((item: string) => item.trim()).filter((item: string) => item.length > 0))
  ).sort((a: string, b: string) => a.localeCompare(b));
};

const extractCommitHash = (briefing: SessionBriefing): string | null => {
  const haystack = [briefing.summary, ...briefing.nextSteps, ...briefing.keyDecisions].join(' ');
  const match = haystack.match(/\b[0-9a-f]{7,40}\b/i);
  return match?.[0] ?? null;
};

const extractFunctionNames = (briefing: SessionBriefing): string[] => {
  const sources = [
    briefing.summary,
    ...briefing.keyDecisions,
    ...briefing.openQuestions,
    ...briefing.nextSteps,
  ];

  const names = new Set<string>();

  for (const source of sources) {
    const inlineCallMatches = source.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)\(/g);
    for (const match of inlineCallMatches) {
      names.add(match[1]);
    }

    const functionMatches = source.matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\b/g);
    for (const match of functionMatches) {
      names.add(match[1]);
    }
  }

  return Array.from(names);
};

const listSearchFiles = async (rootDir: string): Promise<string[]> => {
  const collected: string[] = [];
  const queue: string[] = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) {
      continue;
    }

    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        queue.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (SEARCH_EXTENSIONS.has(extname(entry.name))) {
        collected.push(fullPath);
      }
    }
  }

  return collected;
};

const detectChangedFilesFromGit = async (
  cwd: string,
  fromHash: string
): Promise<string[]> => {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--stat', `${fromHash}..HEAD`], {
      cwd,
      encoding: 'utf8',
    });

    const changed = stdout
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line.includes('|'))
      .map((line: string) => line.split('|')[0].trim());

    return toUniqueSorted(changed);
  } catch {
    return [];
  }
};

export class DriftDetector {
  private readonly cwd: string;

  public constructor(cwd: string) {
    this.cwd = cwd;
  }

  public async detect(briefing: SessionBriefing): Promise<DriftReport> {
    const staleFiles: string[] = [];
    const modifiedFiles: string[] = [];
    let validClaims = 0;
    let staleClaims = 0;

    const briefingTimestamp = Date.parse(briefing.timestamp);

    for (const file of briefing.filesModified) {
      const filePath = resolve(this.cwd, file);

      try {
        const fileStat = await stat(filePath);
        validClaims += 1;

        if (!Number.isNaN(briefingTimestamp) && fileStat.mtimeMs > briefingTimestamp) {
          modifiedFiles.push(file);
        }
      } catch {
        staleFiles.push(file);
        staleClaims += 1;
      }
    }

    const claimedFunctions = extractFunctionNames(briefing);
    if (claimedFunctions.length > 0) {
      const files = await listSearchFiles(this.cwd);
      const allContents = await Promise.all(
        files.map(async (filePath: string) => {
          try {
            return await readFile(filePath, 'utf8');
          } catch {
            return '';
          }
        })
      );
      const mergedContents = allContents.join('\n');

      for (const functionName of claimedFunctions) {
        const signaturePattern = new RegExp(
          `(?:function\\s+${functionName}\\b|const\\s+${functionName}\\s*=|${functionName}\\s*\\()`,
          'm'
        );

        if (signaturePattern.test(mergedContents)) {
          validClaims += 1;
        } else {
          staleClaims += 1;
        }
      }
    }

    const commitHash = extractCommitHash(briefing);
    if (commitHash) {
      const gitChanged = await detectChangedFilesFromGit(this.cwd, commitHash);
      modifiedFiles.push(...gitChanged);
    }

    return {
      staleFiles: toUniqueSorted(staleFiles),
      modifiedFiles: toUniqueSorted(modifiedFiles),
      validClaims,
      staleClaims,
      timestamp: new Date().toISOString(),
    };
  }

  public formatReport(report: DriftReport): string {
    return [
      '# Drift Report',
      `Timestamp: ${report.timestamp}`,
      '',
      `Valid claims: ${report.validClaims}`,
      `Stale claims: ${report.staleClaims}`,
      '',
      'Stale files:',
      report.staleFiles.length > 0
        ? report.staleFiles.map((file: string) => `- ${file}`).join('\n')
        : '- none',
      '',
      'Modified files:',
      report.modifiedFiles.length > 0
        ? report.modifiedFiles.map((file: string) => `- ${file}`).join('\n')
        : '- none',
    ].join('\n');
  }
}
