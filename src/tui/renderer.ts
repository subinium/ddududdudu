import { ProcessTerminal } from './terminal.js';

const CSI = '\u001b[';
const ENABLE_SYNC_OUTPUT = '\u001b[?2026h';
const DISABLE_SYNC_OUTPUT = '\u001b[?2026l';
const CLEAR_SCREEN = `${CSI}2J`;
const CURSOR_HOME = `${CSI}H`;
const CLEAR_LINE = `${CSI}2K`;
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;

export interface CursorPosition {
  row: number;
  col: number;
}

export interface LayoutResult {
  lines: string[];
  cursor: CursorPosition;
  overlays?: string[];
}

type LineProvider = () => LayoutResult;

export class Renderer {
  private readonly terminal: ProcessTerminal;
  private previousLines: string[] = [];
  private renderScheduled = false;
  private readonly lineProvider?: LineProvider;

  public constructor(terminal: ProcessTerminal, lineProvider?: LineProvider) {
    this.terminal = terminal;
    this.lineProvider = lineProvider;
  }

  public render(lines: string[], cursor?: CursorPosition): void {
    const maxLines = Math.max(lines.length, this.previousLines.length);
    let buffer = ENABLE_SYNC_OUTPUT + HIDE_CURSOR;

    for (let index = 0; index < maxLines; index += 1) {
      const nextLine = lines[index] ?? '';
      const prevLine = this.previousLines[index] ?? '';

      if (nextLine === prevLine) {
        continue;
      }

      const row = index + 1;
      buffer += `${CSI}${row};1H${CLEAR_LINE}${nextLine}`;
    }

    if (cursor && cursor.row > 0 && cursor.col > 0) {
      buffer += `${CSI}${cursor.row};${cursor.col}H`;
    }

    buffer += SHOW_CURSOR + DISABLE_SYNC_OUTPUT;
    this.previousLines = [...lines];

    if (buffer !== `${ENABLE_SYNC_OUTPUT}${HIDE_CURSOR}${SHOW_CURSOR}${DISABLE_SYNC_OUTPUT}`) {
      this.terminal.write(buffer);
    }
  }

  public renderWithOverlays(result: LayoutResult): void {
    this.render(result.lines, result.cursor);
    if (result.overlays && result.overlays.length > 0) {
      this.terminal.write(result.overlays.join(''));
      if (result.cursor && result.cursor.row > 0 && result.cursor.col > 0) {
        this.terminal.write(`${CSI}${result.cursor.row};${result.cursor.col}H`);
      }
    }
  }

  public requestRender(): void {
    if (this.renderScheduled) {
      return;
    }

    this.renderScheduled = true;
    process.nextTick(() => {
      this.renderScheduled = false;
      if (!this.lineProvider) {
        return;
      }

      const result = this.lineProvider();
      this.renderWithOverlays(result);
    });
  }

  public invalidate(): void {
    this.previousLines = [];
  }

  public clear(): void {
    this.previousLines = [];
    this.terminal.write(`${ENABLE_SYNC_OUTPUT}${CLEAR_SCREEN}${CURSOR_HOME}${DISABLE_SYNC_OUTPUT}`);
  }
}
