import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { PINK, PINK_BG, RESET, WHITE, visibleLength } from '../colors.js';

const MAX_VISIBLE_ITEMS = 8;
const MAX_FILES = 100;

export interface MentionItem {
  type: 'file' | 'codebase' | 'git' | 'session';
  name: string;
  path?: string;
}

interface RankedMention {
  item: MentionItem;
  score: number;
}

const BUILTIN_MENTIONS: MentionItem[] = [
  { type: 'codebase', name: '@codebase' },
  { type: 'git', name: '@git' },
  { type: 'session', name: '@session' },
];

const fuzzyScore = (text: string, query: string): number => {
  if (query.length === 0) {
    return 1;
  }

  const hay = text.toLowerCase();
  const needle = query.toLowerCase();

  if (hay.startsWith(needle)) {
    return 1000 - (hay.length - needle.length);
  }

  let score = 0;
  let cursor = 0;

  for (const ch of needle) {
    const found = hay.indexOf(ch, cursor);
    if (found < 0) {
      return -1;
    }
    score += found === cursor ? 25 : 8;
    cursor = found + 1;
  }

  return score - (hay.length - needle.length);
};

const clampText = (text: string, width: number): string => {
  if (width <= 0) {
    return '';
  }

  let out = '';
  for (const ch of text) {
    if (visibleLength(out + ch) > width) {
      break;
    }
    out += ch;
  }

  return out;
};

const padText = (text: string, width: number): string => {
  const clipped = clampText(text, width);
  const gap = Math.max(0, width - visibleLength(clipped));
  return clipped + ' '.repeat(gap);
};

export const styleMentionInInput = (input: string, activeMention: string | null): string => {
  if (!activeMention || activeMention.length === 0) {
    return input;
  }

  const idx = input.lastIndexOf(activeMention);
  if (idx < 0) {
    return input;
  }

  return `${input.slice(0, idx)}${PINK}\u001b[4m${activeMention}${RESET}${input.slice(idx + activeMention.length)}`;
};

export class MentionResolver {
  private readonly cwd: string;
  private readonly allFileMentions: MentionItem[] = [];
  private items: MentionItem[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private loadedFiles = false;

  public constructor(cwd: string) {
    this.cwd = cwd;
  }

  public async update(query: string): Promise<void> {
    if (!this.loadedFiles) {
      await this.loadFiles();
      this.loadedFiles = true;
    }

    const normalized = query.trim().replace(/^@/, '');
    const corpus = [...BUILTIN_MENTIONS, ...this.allFileMentions];

    const ranked: RankedMention[] = corpus
      .map((item) => {
        const target = item.name.startsWith('@') ? item.name.slice(1) : item.name;
        const score = Math.max(
          fuzzyScore(target, normalized),
          fuzzyScore(item.path ?? '', normalized),
        );
        return { item, score };
      })
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));

    this.items = ranked.map((entry) => entry.item);
    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  public getItems(): MentionItem[] {
    return [...this.items];
  }

  public moveUp(): void {
    if (this.items.length === 0) {
      return;
    }

    this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
    this.ensureSelectionVisible();
  }

  public moveDown(): void {
    if (this.items.length === 0) {
      return;
    }

    this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
    this.ensureSelectionVisible();
  }

  public select(): MentionItem | null {
    if (this.items.length === 0) {
      return null;
    }
    return this.items[this.selectedIndex] ?? null;
  }

  public dismiss(): void {
    this.items = [];
    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  public render(startRow: number, startCol: number, maxWidth: number): string[] {
    if (this.items.length === 0) {
      return [];
    }

    const width = Math.max(20, maxWidth);
    const visibleCount = Math.min(MAX_VISIBLE_ITEMS, this.items.length);
    const lines: string[] = [];

    for (let i = 0; i < visibleCount; i += 1) {
      const idx = this.scrollOffset + i;
      const item = this.items[idx];
      if (!item) {
        continue;
      }

      const plainLabel = item.type === 'file'
        ? `${item.name} ${item.path ?? ''}`
        : `${item.name} ${item.type}`;

      const selected = idx === this.selectedIndex;
      const line = selected
        ? `${PINK_BG}${WHITE}${padText(plainLabel, width)}${RESET}`
        : padText(plainLabel, width);

      const row = startRow + i;
      lines.push(`\u001b[${row};${startCol}H${line}`);
    }

    return lines;
  }

  private ensureSelectionVisible(): void {
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
      return;
    }

    const maxVisible = this.scrollOffset + MAX_VISIBLE_ITEMS - 1;
    if (this.selectedIndex > maxVisible) {
      this.scrollOffset = this.selectedIndex - MAX_VISIBLE_ITEMS + 1;
    }
  }

  private async loadFiles(): Promise<void> {
    const files = await this.collectFiles(this.cwd, '', []);
    this.allFileMentions.length = 0;
    for (const relativePath of files) {
      const base = relativePath.split('/').pop() ?? relativePath;
      this.allFileMentions.push({
        type: 'file',
        name: `@${base}`,
        path: relativePath,
      });
    }
  }

  private async collectFiles(dir: string, relativeBase: string, acc: string[]): Promise<string[]> {
    if (acc.length >= MAX_FILES) {
      return acc;
    }

    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      const dirents = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
      entries = dirents.map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.isDirectory(),
        isFile: () => entry.isFile(),
      }));
    } catch (err: unknown) {
      void err;
      return acc;
    }

    for (const entry of entries) {
      if (acc.length >= MAX_FILES) {
        break;
      }

      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }

      const rel = relativeBase.length > 0 ? `${relativeBase}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);

      if (entry.isDirectory()) {
        await this.collectFiles(abs, rel, acc);
      } else if (entry.isFile()) {
        acc.push(rel);
      }
    }

    return acc;
  }
}
