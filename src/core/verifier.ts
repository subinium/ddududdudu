import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ChecksRunner } from './checks.js';
import { GitCheckpoint } from './git-checkpoint.js';
import { readPackageScripts, runStructuredVerifierCommand } from './structured-runners.js';

export type VerificationMode = 'none' | 'checks' | 'full';
export type VerificationStatus = 'passed' | 'failed' | 'skipped';

export interface VerificationCommandResult {
  kind: 'lint' | 'test' | 'build' | 'script';
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
  summary?: string;
  highlights?: string[];
  truncated?: boolean;
  category?: string;
  files?: string[];
  rerunHint?: string;
}

export interface VerificationSummary {
  status: VerificationStatus;
  cwd: string;
  fingerprint: string | null;
  changedFiles: string[];
  summary: string;
  report: string;
  commands: VerificationCommandResult[];
}

export interface VerificationProgress {
  phase: 'review' | 'command';
  label: string;
  completed: number;
  total: number;
}

const LARGE_DIFF_FILE_THRESHOLD = 8;
const LARGE_DIFF_CHAR_THRESHOLD = 18_000;

const FILE_PATTERN = /^\+\+\+\s+b\/(.+)$/gm;
const COMMAND_PRIORITIES = ['lint', 'typecheck', 'test', 'build'];

const preview = (value: string, maxLength: number = 240): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const extractChangedFiles = (diff: string): string[] => {
  const files = new Set<string>();
  let match = FILE_PATTERN.exec(diff);
  while (match) {
    const filePath = match[1]?.trim();
    if (filePath) {
      files.add(filePath);
    }
    match = FILE_PATTERN.exec(diff);
  }

  return Array.from(files.values());
};

const shouldUseFullVerificationScripts = (diff: string, changedFiles: string[]): boolean => {
  if (changedFiles.length > LARGE_DIFF_FILE_THRESHOLD) {
    return false;
  }
  if (diff.length > LARGE_DIFF_CHAR_THRESHOLD) {
    return false;
  }
  return true;
};

const countFailedChecks = (report: Awaited<ReturnType<ChecksRunner['runAllChecks']>>): number => {
  return report.checks.filter((check) => !check.passed).length;
};

const toVerificationCommandResult = (
  kind: 'lint' | 'test' | 'build' | 'script',
  result: Awaited<ReturnType<typeof runStructuredVerifierCommand>>,
): VerificationCommandResult => ({
  kind,
  command: result.command,
  ok: result.ok,
  exitCode: result.exitCode,
  output: preview(result.output || result.summary),
  summary: result.summary,
  highlights: result.highlights,
  truncated: result.truncated,
  category: result.category,
  files: result.files,
  rerunHint: result.rerunHint,
});

export class VerificationRunner {
  private readonly cwd: string;

  public constructor(cwd: string) {
    this.cwd = cwd;
  }

  public async run(
    mode: Exclude<VerificationMode, 'none'> = 'checks',
    onProgress?: (progress: VerificationProgress) => void,
  ): Promise<VerificationSummary> {
    const git = new GitCheckpoint(this.cwd);
    if (!(await git.isAvailable())) {
      return {
        status: 'skipped',
        cwd: this.cwd,
        fingerprint: null,
        changedFiles: [],
        summary: 'skipped · not a git repository',
        report: '# Verification\n\nskipped: not a git repository',
        commands: [],
      };
    }

    const diff = await git.getDiff();
    if (!diff.trim()) {
      return {
        status: 'skipped',
        cwd: this.cwd,
        fingerprint: null,
        changedFiles: [],
        summary: 'skipped · no diff detected',
        report: '# Verification\n\nskipped: no diff detected',
        commands: [],
      };
    }

    const fingerprint = createHash('sha1').update(diff).digest('hex');
    const changedFiles = extractChangedFiles(diff);
    const checks = new ChecksRunner(this.cwd);
    onProgress?.({
      phase: 'review',
      label: 'reviewing changed files',
      completed: 0,
      total: 1,
    });
    const report = await checks.runAllChecks(diff);
    onProgress?.({
      phase: 'review',
      label: 'review complete',
      completed: 1,
      total: 1,
    });
    const formattedReview = checks.formatReport(report);
    const commands: VerificationCommandResult[] = [];
    const effectiveMode = mode === 'full' && !shouldUseFullVerificationScripts(diff, changedFiles) ? 'checks' : mode;

    if (effectiveMode === 'full') {
      const scripts = await readPackageScripts(this.cwd);
      const selected = COMMAND_PRIORITIES.filter((name) => typeof scripts[name] === 'string')
        .filter((name) => name !== 'build')
        .slice(0, 3);
      const results = await Promise.all(
        selected.map(async (script, index) => {
          const kind = script === 'test' ? 'test' : script === 'build' ? 'build' : 'lint';
          onProgress?.({
            phase: 'command',
            label: `running ${script}`,
            completed: index,
            total: selected.length,
          });
          const result = toVerificationCommandResult(
            kind,
            await runStructuredVerifierCommand(this.cwd, { kind, script }),
          );
          onProgress?.({
            phase: 'command',
            label: `${script} ${result.ok ? 'passed' : 'failed'}`,
            completed: index + 1,
            total: selected.length,
          });
          return result;
        }),
      );
      commands.push(...results);
    }

    const failedChecks = countFailedChecks(report);
    const failedCommands = commands.filter((command) => !command.ok);
    const status: VerificationStatus = failedChecks === 0 && failedCommands.length === 0 ? 'passed' : 'failed';

    const summary = [
      status,
      failedChecks === 0
        ? `${report.checks.length} checks clean`
        : `${failedChecks}/${report.checks.length} checks flagged`,
      effectiveMode !== mode ? 'fast mode' : null,
      commands.length > 0
        ? failedCommands.length === 0
          ? `${commands.length} scripts passed`
          : `${failedCommands.length}/${commands.length} scripts failed`
        : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' · ');

    const reportLines = [
      '# Verification',
      '',
      `status: ${status}`,
      `cwd: ${this.cwd}`,
      `changed files: ${changedFiles.length > 0 ? changedFiles.join(', ') : 'none detected'}`,
      '',
      '## Review',
      formattedReview,
    ];

    if (commands.length > 0) {
      reportLines.push('', '## Commands');
      for (const command of commands) {
        reportLines.push(
          `- ${command.ok ? 'pass' : 'fail'} · ${command.kind} · ${command.command}${command.exitCode === null ? '' : ` (exit ${command.exitCode})`}`,
        );
        if (command.summary) {
          reportLines.push(`  summary: ${command.summary}`);
        }
        if (command.category) {
          reportLines.push(`  category: ${command.category}`);
        }
        if (command.highlights && command.highlights.length > 0) {
          for (const highlight of command.highlights.slice(0, 3)) {
            reportLines.push(`  highlight: ${highlight}`);
          }
        }
        if (command.files && command.files.length > 0) {
          reportLines.push(`  files: ${command.files.join(', ')}`);
        }
        if (command.rerunHint) {
          reportLines.push(`  rerun: ${command.rerunHint}`);
        }
        if (command.output) {
          reportLines.push(`  ${command.output}`);
        }
      }
    }

    return {
      status,
      cwd: this.cwd,
      fingerprint,
      changedFiles,
      summary,
      report: reportLines.join('\n'),
      commands,
    };
  }
}
