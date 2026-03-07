import { EventEmitter } from 'node:events';
import type { Component } from '../terminal.js';
import { PINK, DIM, RESET, visibleLength, charWidth } from '../colors.js';

const INVERSE = '\u001b[7m';
const PASTE_LINE_THRESHOLD = 4;

export interface PastedBlock {
  type: 'text' | 'image';
  lineCount: number;
  content: string;
  marker: string;
}

interface InputBarEvents {
  submit: [value: string];
}

export class InputBar implements Component {
  private readonly emitter = new EventEmitter();
  private input = '';
  private cursor = 0;
  private readonly history: string[] = [];
  private historyIndex: number | null = null;
  private readonly pastedBlocks: PastedBlock[] = [];
  private imageCounter = 0;
  private ghostText = '';

  public on<K extends keyof InputBarEvents>(
    eventName: K,
    listener: (...args: InputBarEvents[K]) => void,
  ): this {
    this.emitter.on(eventName, listener);
    return this;
  }

  public off<K extends keyof InputBarEvents>(
    eventName: K,
    listener: (...args: InputBarEvents[K]) => void,
  ): this {
    this.emitter.off(eventName, listener);
    return this;
  }

  public setGhostText(text: string): void {
    this.ghostText = text;
  }

  public render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const prompt = `${PINK}❯${RESET} `;

    if (this.input.length === 0 && this.ghostText.length > 0) {
      const ghostLine = `${prompt}${DIM}${this.ghostText}${RESET}`;
      const gVis = visibleLength(ghostLine);
      const gPadded = gVis >= safeWidth ? ghostLine : ghostLine + ' '.repeat(safeWidth - gVis);
      return [gPadded];
    }

    const before = this.input.slice(0, this.cursor);
    const currentChar = this.input[this.cursor] ?? ' ';
    const after = this.input.slice(this.cursor + 1);
    const line = `${prompt}${before}${INVERSE}${currentChar}${RESET}${after}`;
    const vis = visibleLength(line);
    const padded = vis >= safeWidth ? line : line + ' '.repeat(safeWidth - vis);
    return [padded];
  }

  public handleInput(data: string): boolean {
    if (data === '\r' || data === '\n') {
      this.submit();
      return true;
    }

    if (data === '\x7f') {
      this.backspace();
      return true;
    }

    if (data === '\x1b[D') {
      this.cursor = Math.max(0, this.cursor - 1);
      return true;
    }

    if (data === '\x1b[C') {
      this.cursor = Math.min(this.input.length, this.cursor + 1);
      return true;
    }

    if (data === '\x1b[A') {
      this.historyUp();
      return true;
    }

    if (data === '\x1b[B') {
      this.historyDown();
      return true;
    }

    if (data === '\x1b[3~') {
      this.deleteForward();
      return true;
    }

    if (data === '\x1b[H' || data === '\x1bOH') {
      this.cursor = 0;
      return true;
    }

    if (data === '\x1b[F' || data === '\x1bOF') {
      this.cursor = this.input.length;
      return true;
    }

    const pasted = this.parseBracketedPaste(data);
    if (pasted !== null) {
      this.insert(pasted);
      return true;
    }

    if (this.isPrintable(data)) {
      this.insert(data);
      return true;
    }

    return false;
  }

  public getInput(): string {
    return this.input;
  }

  public getCursorColumn(): number {
    const promptWidth = 2;
    const textBefore = this.input.slice(0, this.cursor);
    return promptWidth + charWidth(textBefore);
  }

  public clear(): void {
    this.input = '';
    this.cursor = 0;
    this.historyIndex = null;
    this.pastedBlocks.length = 0;
  }

  private submit(): void {
    const expanded = this.pastedBlocks.length > 0 ? this.expandInput() : this.input;
    if (expanded.length > 0) {
      this.history.push(this.input);
    }

    this.emitter.emit('submit', expanded);
    this.clear();
  }

  private insert(value: string): void {
    this.input = `${this.input.slice(0, this.cursor)}${value}${this.input.slice(this.cursor)}`;
    this.cursor += value.length;
    this.historyIndex = null;
  }

  private backspace(): void {
    if (this.cursor === 0) {
      return;
    }

    this.input = `${this.input.slice(0, this.cursor - 1)}${this.input.slice(this.cursor)}`;
    this.cursor -= 1;
  }

  private deleteForward(): void {
    if (this.cursor >= this.input.length) {
      return;
    }

    this.input = `${this.input.slice(0, this.cursor)}${this.input.slice(this.cursor + 1)}`;
  }

  private historyUp(): void {
    if (this.history.length === 0) {
      return;
    }

    if (this.historyIndex === null) {
      this.historyIndex = this.history.length - 1;
    } else {
      this.historyIndex = Math.max(0, this.historyIndex - 1);
    }

    this.applyHistoryEntry();
  }

  private historyDown(): void {
    if (this.history.length === 0 || this.historyIndex === null) {
      return;
    }

    if (this.historyIndex >= this.history.length - 1) {
      this.historyIndex = null;
      this.input = '';
      this.cursor = 0;
      return;
    }

    this.historyIndex += 1;
    this.applyHistoryEntry();
  }

  private applyHistoryEntry(): void {
    if (this.historyIndex === null) {
      return;
    }

    const entry = this.history[this.historyIndex] ?? '';
    this.input = entry;
    this.cursor = entry.length;
  }

  private isPrintable(data: string): boolean {
    if (data.length === 0 || data.startsWith('\x1b')) {
      return false;
    }

    return /^[^\u0000-\u001f\u007f]+$/u.test(data);
  }

  public getPastedBlocks(): readonly PastedBlock[] {
    return this.pastedBlocks;
  }

  public expandInput(): string {
    let expanded = this.input;
    for (const block of this.pastedBlocks) {
      expanded = expanded.replace(block.marker, block.content);
    }
    return expanded;
  }

  private parseBracketedPaste(data: string): string | null {
    const start = '\u001b[200~';
    const end = '\u001b[201~';
    if (!data.includes(start) || !data.includes(end)) {
      return null;
    }

    const raw = data.replace(start, '').replace(end, '');

    if (this.looksLikeImage(raw)) {
      this.imageCounter += 1;
      const marker = `[Image #${this.imageCounter}]`;
      this.pastedBlocks.push({
        type: 'image',
        lineCount: 1,
        content: raw,
        marker,
      });
      return marker;
    }

    const lines = raw.split('\n');
    if (lines.length >= PASTE_LINE_THRESHOLD) {
      const marker = `[Paste ${lines.length} lines]`;
      this.pastedBlocks.push({
        type: 'text',
        lineCount: lines.length,
        content: raw,
        marker,
      });
      return marker;
    }

    return raw;
  }

  private looksLikeImage(data: string): boolean {
    if (data.startsWith('data:image/')) return true;
    if (/^[A-Za-z0-9+/=\s]{200,}$/u.test(data.slice(0, 300))) return true;
    return false;
  }
}
