import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parseYaml } from '../utils/yaml.js';

import { DEFAULT_ANTHROPIC_BASE_URL } from '../api/anthropic-base-url.js';
import type { SubAgentPool, TaskResult } from './sub-agent.js';

export interface CheckDefinition {
  name: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  tools: string[];
  instructions: string;
  path: string;
}

export interface CheckResult {
  checkName: string;
  severity: string;
  findings: string[];
  passed: boolean;
}

export interface ReviewReport {
  checks: CheckResult[];
  summary: string;
  timestamp: string;
}

interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

interface ParsedSubAgentResponse {
  passed: boolean;
  findings: string[];
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const CHECK_FILE_PATTERN = /\/(?:\.agents|\.ddudu)\/checks\/[^/]+\.md$/;

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const toPosixPath = (value: string): string => {
  return value.replace(/\\/g, '/');
};

const toSeverity = (value: unknown): CheckDefinition['severity'] => {
  if (typeof value !== 'string') {
    return 'medium';
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'critical') {
    return normalized;
  }

  return 'medium';
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry: unknown): entry is string => {
      return typeof entry === 'string' && entry.trim().length > 0;
    })
    .map((entry: string) => entry.trim());
};

const parseMarkdownFrontmatter = (content: string): ParsedMarkdown => {
  const match = FRONTMATTER_PATTERN.exec(content);
  if (!match) {
    return {
      frontmatter: {},
      body: content,
    };
  }

  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1] ?? '') as unknown;
    if (isObject(parsed)) {
      frontmatter = parsed;
    }
  } catch {
    frontmatter = {};
  }

  return {
    frontmatter,
    body: content.slice(match[0].length),
  };
};

const extractChangedFiles = (diff: string): string[] => {
  const files = new Set<string>();
  const lines = diff.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const match = /^\+\+\+\s+b\/(.+)$/.exec(line);
    if (!match) {
      continue;
    }

    const candidate = match[1]?.trim();
    if (!candidate || candidate === '/dev/null') {
      continue;
    }

    files.add(candidate);
  }

  return Array.from(files.values());
};

const compareScopeDepth = (a: string, b: string): number => {
  const aDepth = toPosixPath(a).split('/').filter((segment: string) => segment.length > 0).length;
  const bDepth = toPosixPath(b).split('/').filter((segment: string) => segment.length > 0).length;
  return aDepth - bDepth;
};

const parseSubAgentResponse = (text: string): ParsedSubAgentResponse | null => {
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  const raw = text.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (!isObject(parsed)) {
    return null;
  }

  const passed = parsed.passed;
  const findings = parsed.findings;

  if (typeof passed !== 'boolean') {
    return null;
  }

  if (!Array.isArray(findings) || findings.some((entry: unknown) => typeof entry !== 'string')) {
    return null;
  }

  return {
    passed,
    findings,
  };
};

const sourcePriority = (path: string): number => {
  const normalized = toPosixPath(path);
  if (normalized.includes('/.ddudu/checks/')) {
    return 2;
  }

  if (normalized.includes('/.agents/checks/')) {
    return 1;
  }

  return 0;
};

export class ChecksRunner {
  private readonly cwd: string;
  private readonly reviewToken?: string;
  private readonly reviewBaseUrl?: string;
  private readonly reviewModel?: string;
  private pool?: SubAgentPool;
  private poolPromise: Promise<SubAgentPool | undefined> | null = null;

  public constructor(cwd: string) {
    this.cwd = cwd;

    const token = process.env.DDUDU_ANTHROPIC_TOKEN ?? process.env.ANTHROPIC_API_KEY;
    if (!token) {
      return;
    }

    this.reviewToken = token;
    this.reviewBaseUrl = process.env.DDUDU_ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL;
    this.reviewModel = process.env.DDUDU_REVIEW_MODEL ?? 'claude-sonnet-4-6';
  }

  public async scan(): Promise<CheckDefinition[]> {
    const checkFiles = await this.discoverCheckFiles(this.cwd);
    const definitions = await Promise.all(
      checkFiles.map(async (filePath: string): Promise<CheckDefinition | null> => {
        let raw = '';
        try {
          raw = await readFile(filePath, 'utf8');
        } catch {
          return null;
        }

        const parsed = parseMarkdownFrontmatter(raw);
        const name = typeof parsed.frontmatter.name === 'string' && parsed.frontmatter.name.trim().length > 0
          ? parsed.frontmatter.name.trim()
          : basename(filePath, '.md');

        const description = typeof parsed.frontmatter.description === 'string'
          ? parsed.frontmatter.description.trim()
          : '';

        return {
          name,
          description,
          severity: toSeverity(parsed.frontmatter['severity-default']),
          tools: toStringArray(parsed.frontmatter.tools),
          instructions: parsed.body.trim(),
          path: filePath,
        };
      })
    );

    return definitions
      .filter((definition: CheckDefinition | null): definition is CheckDefinition => definition !== null)
      .sort((a: CheckDefinition, b: CheckDefinition) => a.path.localeCompare(b.path));
  }

  public async runCheck(check: CheckDefinition, diff: string): Promise<CheckResult> {
    if (this.pool) {
      const result = await this.runWithSubAgent(check, diff);
      return {
        checkName: check.name,
        severity: check.severity,
        findings: result.findings,
        passed: result.passed,
      };
    }

    const findings = this.runFallbackHeuristics(check, diff);
    return {
      checkName: check.name,
      severity: check.severity,
      findings,
      passed: findings.length === 0,
    };
  }

  public async runAllChecks(diff: string): Promise<ReviewReport> {
    const definitions = await this.scan();
    const changedFiles = extractChangedFiles(diff).map((filePath: string) => resolve(this.cwd, filePath));
    const targets = changedFiles.length > 0 ? changedFiles : [this.cwd];

    const selectedByPath = new Map<string, CheckDefinition>();
    for (const target of targets) {
      const applicable = this.selectChecksForFile(definitions, target);
      for (const check of applicable) {
        selectedByPath.set(check.path, check);
      }
    }

    const selectedChecks = Array.from(selectedByPath.values());
    const checks = await Promise.all(
      selectedChecks.map((check: CheckDefinition) => this.runCheck(check, diff))
    );

    const passedCount = checks.filter((check: CheckResult) => check.passed).length;
    const failedCount = checks.length - passedCount;
    const summary = failedCount === 0
      ? `All ${checks.length} checks passed.`
      : `${failedCount}/${checks.length} checks failed.`;

    return {
      checks,
      summary,
      timestamp: new Date().toISOString(),
    };
  }

  public formatReport(report: ReviewReport): string {
    const lines: string[] = [];
    lines.push(`# Review Report (${report.timestamp})`);
    lines.push('');
    lines.push(report.summary);
    lines.push('');

    if (report.checks.length === 0) {
      lines.push('No checks were discovered.');
      return lines.join('\n');
    }

    for (const check of report.checks) {
      const status = check.passed ? 'PASS' : 'FAIL';
      lines.push(`- [${status}] ${check.checkName} (${check.severity})`);
      if (check.findings.length === 0) {
        lines.push('  - No findings.');
      } else {
        for (const finding of check.findings) {
          lines.push(`  - ${finding}`);
        }
      }
    }

    return lines.join('\n');
  }

  private async discoverCheckFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    const stack = [root];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true, encoding: 'utf8' });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = resolve(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') {
            continue;
          }

          stack.push(fullPath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const normalized = toPosixPath(fullPath);
        if (CHECK_FILE_PATTERN.test(normalized)) {
          files.push(fullPath);
        }
      }
    }

    return files;
  }

  private selectChecksForFile(definitions: CheckDefinition[], filePath: string): CheckDefinition[] {
    const normalizedFile = toPosixPath(filePath);
    const grouped = new Map<string, CheckDefinition>();

    for (const definition of definitions) {
      const scopeRoot = this.getScopeRoot(definition.path);
      const normalizedScope = toPosixPath(scopeRoot);

      if (!this.isInScope(normalizedFile, normalizedScope)) {
        continue;
      }

      const current = grouped.get(definition.name);
      if (!current) {
        grouped.set(definition.name, definition);
        continue;
      }

      const currentScope = this.getScopeRoot(current.path);
      const depthCompare = compareScopeDepth(scopeRoot, currentScope);
      if (depthCompare > 0) {
        grouped.set(definition.name, definition);
        continue;
      }

      if (depthCompare === 0 && sourcePriority(definition.path) > sourcePriority(current.path)) {
        grouped.set(definition.name, definition);
      }
    }

    return Array.from(grouped.values());
  }

  private getScopeRoot(checkPath: string): string {
    const normalized = toPosixPath(checkPath);
    const markers = ['/.agents/checks/', '/.ddudu/checks/'];

    for (const marker of markers) {
      const index = normalized.indexOf(marker);
      if (index >= 0) {
        return checkPath.slice(0, index);
      }
    }

    return this.cwd;
  }

  private isInScope(filePath: string, scopeRoot: string): boolean {
    if (filePath === scopeRoot) {
      return true;
    }

    if (scopeRoot.length === 0) {
      return true;
    }

    return filePath.startsWith(`${scopeRoot}/`);
  }

  private async runWithSubAgent(check: CheckDefinition, diff: string): Promise<ParsedSubAgentResponse> {
    const pool = await this.getPool();
    if (!pool) {
      return {
        passed: true,
        findings: [],
      };
    }

    const prompt = [
      `Check Name: ${check.name}`,
      `Severity: ${check.severity}`,
      `Description: ${check.description}`,
      `Allowed tools: ${check.tools.join(', ') || '(none specified)'}`,
      '',
      'Check instructions:',
      check.instructions,
      '',
      'Diff to review:',
      diff,
      '',
      'Return JSON only in this format:',
      '{"passed": boolean, "findings": ["string"]}',
    ].join('\n');

    let result: TaskResult;
    try {
      result = await pool.runTask({
        id: `review-check-${check.name}-${randomUUID()}`,
        prompt,
        role: 'reviewer',
      });
    } catch (err: unknown) {
      return {
        passed: false,
        findings: [err instanceof Error ? err.message : String(err)],
      };
    }

    if (result.status !== 'completed') {
      return {
        passed: false,
        findings: [result.error ?? `Sub-agent ${result.status}.`],
      };
    }

    const parsed = parseSubAgentResponse(result.text);
    if (!parsed) {
      return {
        passed: false,
        findings: ['Sub-agent returned invalid JSON response.'],
      };
    }

    return parsed;
  }

  private runFallbackHeuristics(check: CheckDefinition, diff: string): string[] {
    const findings: string[] = [];
    const normalizedName = `${check.name} ${check.description}`.toLowerCase();

    if (normalizedName.includes('security') && /\beval\s*\(/.test(diff)) {
      findings.push('Potential security issue: eval(...) found in diff.');
    }

    if (normalizedName.includes('performance') && /forEach\s*\(\s*async\b/.test(diff)) {
      findings.push('Potential performance issue: async callback in forEach may serialize unexpectedly.');
    }

    if (/\bconsole\.log\s*\(/.test(diff)) {
      findings.push('Debug logging found in diff: console.log(...).');
    }

    if (/\bdebugger\b/.test(diff)) {
      findings.push('Debugger statement found in diff.');
    }

    if (/\bTODO\b|\bFIXME\b/.test(diff)) {
      findings.push('TODO/FIXME marker found in diff.');
    }

    return findings;
  }

  private async getPool(): Promise<SubAgentPool | undefined> {
    if (this.pool) {
      return this.pool;
    }

    if (this.poolPromise) {
      return this.poolPromise;
    }

    if (!this.reviewToken) {
      return undefined;
    }

    this.poolPromise = (async () => {
      const { SubAgentPool } = await import('./sub-agent.js');
      this.pool = new SubAgentPool({
        token: this.reviewToken as string,
        baseUrl: this.reviewBaseUrl ?? DEFAULT_ANTHROPIC_BASE_URL,
        defaultModel: this.reviewModel ?? 'claude-sonnet-4-6',
        defaultSystemPrompt: 'You are a strict code review checker. Return only valid JSON.',
        maxConcurrent: 5,
      });
      return this.pool;
    })();

    try {
      return await this.poolPromise;
    } finally {
      this.poolPromise = null;
    }
  }
}
