import type { Component } from '../terminal.js';
import { visibleLength } from '../colors.js';

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export class ChatView implements Component {
  private lines: string[] = [];
  private scrollOffset = 0;

  public render(width: number, height = 1): string[] {
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    const wrapped = this.wrapAll(safeWidth);
    const maxOffset = Math.max(0, wrapped.length - safeHeight);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    const start = Math.max(0, wrapped.length - safeHeight - this.scrollOffset);
    const slice = wrapped.slice(start, start + safeHeight);

    if (slice.length < safeHeight) {
      const filler = new Array<string>(safeHeight - slice.length).fill('');
      return [...filler, ...slice].map((line) => this.padVisible(line, safeWidth));
    }

    return slice.map((line) => this.padVisible(line, safeWidth));
  }

  public appendLine(line: string): void {
    this.lines.push(line);
  }

  public appendStream(chunk: string): void {
    if (this.lines.length === 0) {
      this.lines.push('');
    }

    const normalized = chunk.replace(/\r/g, '');
    const parts = normalized.split('\n');
    const firstPart = parts.shift() ?? '';

    this.lines[this.lines.length - 1] = `${this.lines[this.lines.length - 1] ?? ''}${firstPart}`;

    parts.forEach((part) => {
      this.lines.push(part);
    });
  }

  public scroll(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - delta);
  }

  public setLines(lines: string[]): void {
    this.lines = [...lines];
    this.scrollOffset = 0;
  }

  public getLines(): string[] {
    return [...this.lines];
  }

  private padVisible(line: string, width: number): string {
    const vis = visibleLength(line);
    if (vis >= width) return line;
    return line + ' '.repeat(width - vis);
  }

  private wrapAll(width: number): string[] {
    if (this.lines.length === 0) {
      return [''];
    }

    const wrapped: string[] = [];
    this.lines.forEach((line) => {
      const pieces = this.wrapLine(line, width);
      wrapped.push(...pieces);
    });

    return wrapped.length > 0 ? wrapped : [''];
  }

  private wrapLine(line: string, width: number): string[] {
    if (visibleLength(line) <= width) {
      return [line];
    }

    const tokens = this.tokenize(line);
    const output: string[] = [];
    let current = '';
    let currentVisible = 0;

    for (const token of tokens) {
      if (token.type === 'ansi') {
        current += token.raw;
        continue;
      }

      const words = token.raw.split(/(\s+)/);
      for (const word of words) {
        const wordLen = word.length;

        if (wordLen > width) {
          if (currentVisible > 0) {
            output.push(current);
            current = '';
            currentVisible = 0;
          }
          for (let i = 0; i < wordLen; i += width) {
            output.push(word.slice(i, i + width));
          }
          continue;
        }

        if (currentVisible + wordLen > width) {
          output.push(current);
          current = word.trimStart();
          currentVisible = current.length;
          continue;
        }

        current += word;
        currentVisible += wordLen;
      }
    }

    if (current.length > 0) {
      output.push(current);
    }

    return output.length > 0 ? output : [''];
  }

  private tokenize(line: string): Array<{ type: 'text' | 'ansi'; raw: string }> {
    const tokens: Array<{ type: 'text' | 'ansi'; raw: string }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    ANSI_RE.lastIndex = 0;
    while ((match = ANSI_RE.exec(line)) !== null) {
      if (match.index > lastIndex) {
        tokens.push({ type: 'text', raw: line.slice(lastIndex, match.index) });
      }
      tokens.push({ type: 'ansi', raw: match[0] });
      lastIndex = ANSI_RE.lastIndex;
    }

    if (lastIndex < line.length) {
      tokens.push({ type: 'text', raw: line.slice(lastIndex) });
    }

    return tokens;
  }
}
