import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { loadConfigForCwd } from '../core/config.js';

export interface MentionItem {
  type: 'file' | 'codebase' | 'git' | 'session';
  name: string;
  path?: string;
}

const MAX_FILE_BYTES = 50 * 1024;
const MAX_SESSION_LINES = 6;

const truncateBytes = (content: string, limit: number): { text: string; truncated: boolean } => {
  const buf = Buffer.from(content, 'utf8');
  if (buf.byteLength <= limit) {
    return { text: content, truncated: false };
  }

  const sliced = buf.subarray(0, limit).toString('utf8');
  return { text: sliced, truncated: true };
};

const toNumberedLines = (content: string): string => {
  const lines = content.replace(/\r/g, '').split('\n');
  const width = String(lines.length).length;
  return lines
    .map((line, idx) => `${String(idx + 1).padStart(width, ' ')}: ${line}`)
    .join('\n');
};

const previewText = (value: string, maxLength: number = 160): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const isNamedMode = (value: unknown): value is 'jennie' | 'lisa' | 'rosé' | 'jisoo' =>
  value === 'jennie' || value === 'lisa' || value === 'rosé' || value === 'jisoo';

const runShell = async (cwd: string, command: string): Promise<{ stdout: string; stderr: string }> => {
  return new Promise((resolvePromise) => {
    const child = spawn('bash', ['-lc', command], { cwd });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });

    child.on('close', () => {
      resolvePromise({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd() });
    });

    child.on('error', (err: Error) => {
      resolvePromise({ stdout: '', stderr: err.message });
    });
  });
};

const collectTree = async (cwd: string): Promise<string[]> => {
  const out: string[] = [];

  const walk = async (dir: string, relBase: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }

      const rel = relBase.length > 0 ? `${relBase}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      try {
        const info = await stat(abs);
        out.push(`${rel} (${info.size} bytes)`);
      } catch (err: unknown) {
        void err;
      }
    }
  };

  try {
    await walk(cwd, '');
  } catch (err: unknown) {
    void err;
  }

  return out;
};

const resolveFileMention = async (mention: MentionItem, cwd: string): Promise<string> => {
  const relativePath = mention.path ?? mention.name.replace(/^@/, '');
  const absolutePath = resolve(cwd, relativePath);

  let raw = '';
  try {
    raw = await readFile(absolutePath, 'utf8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown read error';
    return `<file path="${relativePath}">\n[error] ${message}\n</file>`;
  }

  const limited = truncateBytes(raw, MAX_FILE_BYTES);
  const numbered = toNumberedLines(limited.text);
  const suffix = limited.truncated ? '\n... [truncated to 50KB]' : '';
  return `<file path="${relativePath}">\n${numbered}${suffix}\n</file>`;
};

const resolveCodebaseMention = async (cwd: string): Promise<string> => {
  const files = await collectTree(cwd);
  const body = files.length > 0 ? files.join('\n') : '(no files found)';
  return `<codebase cwd="${cwd}">\n${body}\n</codebase>`;
};

const resolveGitMention = async (cwd: string): Promise<string> => {
  const [logResult, diffResult] = await Promise.all([
    runShell(cwd, 'git log --oneline -20'),
    runShell(cwd, 'git diff --stat'),
  ]);

  const sections = [
    '<git>',
    '<log>',
    logResult.stdout || logResult.stderr || '(no log output)',
    '</log>',
    '<diffstat>',
    diffResult.stdout || diffResult.stderr || '(no diffstat output)',
    '</diffstat>',
    '</git>',
  ];

  return sections.join('\n');
};

const resolveSessionDirectory = async (cwd: string): Promise<string> => {
  const config = await loadConfigForCwd(cwd);
  return resolve(cwd, config.session.directory);
};

const resolveSessionFile = async (mention: MentionItem, cwd: string): Promise<string | null> => {
  const sessionDirectory = await resolveSessionDirectory(cwd);
  const entries = await readdir(sessionDirectory).catch(() => [] as string[]);
  const sessionFiles = entries.filter((entry) => entry.endsWith('.jsonl'));
  if (sessionFiles.length === 0) {
    return null;
  }

  const target = (mention.path ?? mention.name.replace(/^@/, '')).trim();
  if (!target || target === 'session' || target === 'sessions' || target === 'current' || target === 'latest') {
    const ranked = await Promise.all(
      sessionFiles.map(async (entry) => {
        const filePath = resolve(sessionDirectory, entry);
        const info = await stat(filePath);
        return {
          filePath,
          mtime: info.mtimeMs,
        };
      }),
    );
    ranked.sort((left, right) => right.mtime - left.mtime);
    return ranked[0]?.filePath ?? null;
  }

  const explicitCandidates = [
    resolve(sessionDirectory, target),
    resolve(cwd, target),
    target.endsWith('.jsonl') ? null : resolve(sessionDirectory, `${target}.jsonl`),
  ].filter((candidate): candidate is string => typeof candidate === 'string');

  for (const candidate of explicitCandidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        return candidate;
      }
    } catch {
      // Ignore lookup failures and continue to fallback matching.
    }
  }

  const prefixed = sessionFiles.find((entry) => entry === `${target}.jsonl` || entry.startsWith(target));
  return prefixed ? resolve(sessionDirectory, prefixed) : null;
};

const summarizeArtifacts = (artifacts: unknown): string | null => {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return null;
  }

  const summarized = artifacts
    .filter((artifact): artifact is Record<string, unknown> => typeof artifact === 'object' && artifact !== null)
    .slice(-3)
    .map((artifact) => {
      const kind = readString(artifact.kind) ?? 'artifact';
      const title = readString(artifact.title) ?? readString(artifact.summary) ?? kind;
      return `${kind}: ${previewText(title, 72)}`;
    });

  return summarized.length > 0 ? summarized.join(' | ') : null;
};

const summarizeBackgroundJobs = (jobs: unknown): string | null => {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return null;
  }

  const counts = {
    running: 0,
    done: 0,
    cancelled: 0,
    error: 0,
  };

  for (const job of jobs) {
    if (typeof job !== 'object' || job === null) {
      continue;
    }

    const status = (job as Record<string, unknown>).status;
    if (status === 'running' || status === 'done' || status === 'cancelled' || status === 'error') {
      counts[status] += 1;
    }
  }

  const parts = [
    counts.running > 0 ? `${counts.running} running` : null,
    counts.done > 0 ? `${counts.done} done` : null,
    counts.cancelled > 0 ? `${counts.cancelled} cancelled` : null,
    counts.error > 0 ? `${counts.error} error` : null,
  ].filter((part): part is string => typeof part === 'string');

  return parts.length > 0 ? parts.join(' | ') : null;
};

const resolveSessionMention = async (mention: MentionItem, cwd: string): Promise<string> => {
  let sessionFile: string | null = null;
  try {
    sessionFile = await resolveSessionFile(mention, cwd);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `<session>\n[error] ${message}\n</session>`;
  }

  if (!sessionFile) {
    return '<session>\n[error] no session files found\n</session>';
  }

  let raw = '';
  try {
    raw = await readFile(sessionFile, 'utf8');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `<session path="${sessionFile}">\n[error] ${message}\n</session>`;
  }

  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  let header: Record<string, unknown> | null = null;
  let controllerState: Record<string, unknown> | null = null;
  const recentMessages: string[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === 'header' && typeof parsed.data === 'object' && parsed.data !== null) {
        header = parsed.data as Record<string, unknown>;
        continue;
      }

      if (parsed.type !== 'message' || typeof parsed.data !== 'object' || parsed.data === null) {
        continue;
      }

      const data = parsed.data as Record<string, unknown>;
      if (data.kind === 'controller_state' && typeof data.controllerState === 'object' && data.controllerState !== null) {
        controllerState = data.controllerState as Record<string, unknown>;
      }

      for (const role of ['user', 'assistant', 'system'] as const) {
        const text = readString(data[role]);
        if (text) {
          recentMessages.push(`${role}: ${previewText(text, 160)}`);
        }
      }
    } catch {
      // Ignore malformed lines and continue best-effort parsing.
    }
  }

  const headerMetadata =
    header && typeof header.metadata === 'object' && header.metadata !== null
      ? (header.metadata as Record<string, unknown>)
      : null;
  const headerMode = headerMetadata ? readString(headerMetadata.mode) : undefined;
  const stateMode = controllerState ? readString(controllerState.mode) : undefined;
  const mode = isNamedMode(stateMode) ? stateMode : isNamedMode(headerMode) ? headerMode : undefined;
  const artifactsSummary = controllerState ? summarizeArtifacts(controllerState.artifacts) : null;
  const backgroundSummary = controllerState ? summarizeBackgroundJobs(controllerState.backgroundJobs) : null;

  const body = [
    `<session path="${sessionFile}">`,
    `id: ${readString(header?.id) ?? 'unknown'}`,
    readString(header?.title) ? `title: ${readString(header?.title)}` : null,
    readString(header?.provider) ? `provider: ${readString(header?.provider)}` : null,
    readString(header?.model) ? `model: ${readString(header?.model)}` : null,
    mode ? `mode: ${mode}` : null,
    artifactsSummary ? `artifacts: ${artifactsSummary}` : null,
    backgroundSummary ? `background: ${backgroundSummary}` : null,
    recentMessages.length > 0 ? 'recent:' : null,
    ...recentMessages.slice(-MAX_SESSION_LINES).map((line) => `- ${line}`),
    '</session>',
  ].filter((line): line is string => typeof line === 'string');

  return body.join('\n');
};

export const resolveFileContext = async (mention: MentionItem, cwd: string): Promise<string> => {
  switch (mention.type) {
    case 'file':
      return resolveFileMention(mention, cwd);
    case 'codebase':
      return resolveCodebaseMention(cwd);
    case 'git':
      return resolveGitMention(cwd);
    case 'session':
      return resolveSessionMention(mention, cwd);
    default:
      return '';
  }
};

export const resolveMultipleMentions = async (
  mentions: MentionItem[],
  cwd: string,
): Promise<string> => {
  const unique = new Map<string, MentionItem>();
  for (const mention of mentions) {
    const key = `${mention.type}:${mention.path ?? mention.name}`;
    if (!unique.has(key)) {
      unique.set(key, mention);
    }
  }

  const contexts = await Promise.all(
    [...unique.values()].map((mention) => resolveFileContext(mention, cwd)),
  );

  return contexts.filter((block) => block.length > 0).join('\n\n');
};
