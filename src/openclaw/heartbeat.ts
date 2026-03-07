import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface HeartbeatRule {
  schedule: string;
  command: string;
  raw: string;
  line: number;
}

const defaultHeartbeatSearchPaths = (): string[] => {
  return [
    join(process.cwd(), '.ddudu', 'HEARTBEAT.md'),
    join(homedir(), '.ddudu', 'HEARTBEAT.md'),
    join(process.cwd(), 'HEARTBEAT.md'),
  ];
};

export const loadHeartbeat = async (searchPaths?: string[]): Promise<string | null> => {
  const candidates =
    searchPaths && searchPaths.length > 0 ? searchPaths : defaultHeartbeatSearchPaths();

  for (const filePath of candidates) {
    try {
      const content = await readFile(filePath, 'utf8');
      if (content.trim().length > 0) {
        return content;
      }
    } catch {
      continue;
    }
  }

  return null;
};

export const parseHeartbeat = (content: string): HeartbeatRule[] => {
  const lines = content.split(/\r?\n/);
  const rules: HeartbeatRule[] = [];

  const cronPattern =
    /^(@(?:yearly|annually|monthly|weekly|daily|midnight|hourly|reboot)|(?:\S+\s+){4}\S+)(?:\s+(.*))?$/;

  lines.forEach((line, index) => {
    const normalized = line.trim();
    if (!normalized || normalized.startsWith('#')) {
      return;
    }

    const withoutListPrefix = normalized.replace(/^[*-]\s+/, '');
    const matched = withoutListPrefix.match(cronPattern);
    if (!matched) {
      return;
    }

    const schedule = matched[1].trim();
    const command = matched[2]?.trim() ?? '';
    rules.push({
      schedule,
      command,
      raw: line,
      line: index + 1,
    });
  });

  return rules;
};
