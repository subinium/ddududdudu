import { mkdir, readdir, readFile, stat, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  type LoadedSession,
  type SessionCreateOptions,
  type SessionEntry,
  type SessionHeader,
  type SessionListItem,
} from './types.js';
import { getDduduPaths } from './dirs.js';

const DEFAULT_SESSION_DIR = getDduduPaths().globalSessions;

const previewText = (value: string, maxLength: number = 72): string => {
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

const isNamedMode = (value: unknown): value is SessionListItem['mode'] =>
  value === 'jennie' || value === 'lisa' || value === 'rosé' || value === 'jisoo';

const readSessionHeaderMode = (header: SessionHeader): SessionListItem['mode'] | undefined => {
  const metadata = header.metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return undefined;
  }

  const mode = (metadata as Record<string, unknown>).mode;
  return isNamedMode(mode) ? mode : undefined;
};

const parseLine = (line: string): SessionEntry | null => {
  if (!line.trim()) {
    return null;
  }

  const parsed = JSON.parse(line) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const record = parsed as SessionEntry;
  if (!record.type || !record.timestamp || !record.data) {
    return null;
  }

  return record;
};

export class SessionManager {
  private readonly sessionDirectory: string;

  public constructor(sessionDirectory: string = DEFAULT_SESSION_DIR) {
    this.sessionDirectory = resolve(process.cwd(), sessionDirectory);
  }

  public async create(opts: SessionCreateOptions = {}): Promise<SessionHeader> {
    await mkdir(this.sessionDirectory, { recursive: true });

    const now = new Date().toISOString();
    const header: SessionHeader = {
      id: randomUUID(),
      createdAt: now,
      title: opts.title,
      parentId: opts.parentId,
      provider: opts.provider,
      model: opts.model,
      metadata: opts.metadata,
    };

    const headerRecord: SessionEntry = {
      type: 'header',
      timestamp: now,
      data: header as unknown as { [key: string]: unknown },
    };

    await appendFile(
      this.getSessionFilePath(header.id),
      `${JSON.stringify(headerRecord)}\n`,
      'utf8'
    );

    return header;
  }

  public async append(sessionId: string, entry: SessionEntry): Promise<void> {
    await mkdir(this.sessionDirectory, { recursive: true });

    const normalizedEntry: SessionEntry = {
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    };

    await appendFile(
      this.getSessionFilePath(sessionId),
      `${JSON.stringify(normalizedEntry)}\n`,
      'utf8'
    );
  }

  public async load(sessionId: string): Promise<LoadedSession> {
    const filePath = this.getSessionFilePath(sessionId);
    const content = await readFile(filePath, 'utf8');

    const lines = content.split('\n').filter((line: string) => line.trim().length > 0);
    const entries: SessionEntry[] = [];
    let header: SessionHeader | null = null;

    for (const line of lines) {
      const record = parseLine(line);
      if (!record) {
        continue;
      }

      if (record.type === 'header') {
        header = record.data as unknown as SessionHeader;
        continue;
      }

      entries.push(record);
    }

    if (!header) {
      throw new Error(`Session header missing for ${sessionId}`);
    }

    return {
      header,
      entries,
    };
  }

  public async list(): Promise<SessionListItem[]> {
    await mkdir(this.sessionDirectory, { recursive: true });

    const files = await readdir(this.sessionDirectory);
    const jsonlFiles = files.filter((name: string) => name.endsWith('.jsonl'));

    const sessions = await Promise.all(
      jsonlFiles.map(async (fileName: string): Promise<SessionListItem | null> => {
        const filePath = resolve(this.sessionDirectory, fileName);
        const [fileStat, content] = await Promise.all([
          stat(filePath),
          readFile(filePath, 'utf8'),
        ]);

        const records = content
          .split('\n')
          .map((line: string) => parseLine(line))
          .filter((entry: SessionEntry | null): entry is SessionEntry => entry !== null);

        const headerRecord = records.find((record: SessionEntry) => record.type === 'header');
        if (!headerRecord) {
          return null;
        }

        const sessionHeader = headerRecord.data as unknown as SessionHeader;
        const latestMessage = records
          .slice()
          .reverse()
          .find((record: SessionEntry) => {
            const user = readString(record.data.user);
            const assistant = readString(record.data.assistant);
            return Boolean(user || assistant);
          });

        const latestUser = latestMessage ? readString(latestMessage.data.user) : undefined;
        const latestAssistant = latestMessage ? readString(latestMessage.data.assistant) : undefined;
        const provider = readString(sessionHeader.provider)
          ?? (latestMessage ? readString(latestMessage.data.provider) : undefined);
        const model = readString(sessionHeader.model)
          ?? (latestMessage ? readString(latestMessage.data.model) : undefined);
        const mode =
          readSessionHeaderMode(sessionHeader)
          ?? (latestMessage && isNamedMode(latestMessage.data.mode)
            ? latestMessage.data.mode
            : undefined);
        const preview = previewText(latestUser ?? latestAssistant ?? '');
        const title = sessionHeader.title?.trim() || preview || undefined;

        return {
          id: sessionHeader.id,
          path: filePath,
          createdAt: sessionHeader.createdAt,
          updatedAt: fileStat.mtime.toISOString(),
          entryCount: Math.max(records.length - 1, 0),
          parentId: sessionHeader.parentId,
          title,
          provider,
          model,
          mode,
          preview: preview || undefined,
        };
      })
    );

    return sessions
      .filter((item: SessionListItem | null): item is SessionListItem => item !== null)
      .sort((a: SessionListItem, b: SessionListItem) =>
        b.updatedAt.localeCompare(a.updatedAt)
      );
  }

  public getSessionDirectory(): string {
    return this.sessionDirectory;
  }

  public getArtifactDirectory(sessionId: string): string {
    return resolve(this.sessionDirectory, sessionId);
  }

  private getSessionFilePath(sessionId: string): string {
    return resolve(this.sessionDirectory, `${sessionId}.jsonl`);
  }
}
