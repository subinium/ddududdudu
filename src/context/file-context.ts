import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export interface MentionItem {
  type: 'file' | 'codebase' | 'git' | 'session';
  name: string;
  path?: string;
}

const MAX_FILE_BYTES = 50 * 1024;

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

const resolveSessionMention = async (): Promise<string> => {
  return '<session>current session summary</session>';
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
      return resolveSessionMention();
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
