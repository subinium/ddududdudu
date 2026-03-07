import { EventEmitter } from 'node:events';
import type { ReadStream, WriteStream } from 'node:tty';

const CSI = '\u001b[';
const ENABLE_BRACKETED_PASTE = `${CSI}?2004h`;
const DISABLE_BRACKETED_PASTE = `${CSI}?2004l`;

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface Component {
  render(width: number, height?: number): string[];
  handleInput?(data: string): boolean;
}

type InputHandler = (data: string) => void;
type ResizeHandler = (size: TerminalSize) => void;

interface ProcessTerminalEvents {
  input: [data: string];
  resize: [size: TerminalSize];
}

export class ProcessTerminal {
  private readonly emitter = new EventEmitter();
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private started = false;
  private restoreRawMode = false;
  private inputListener?: (chunk: string | Buffer) => void;
  private resizeListener?: () => void;

  public constructor(
    stdin: NodeJS.ReadStream = process.stdin,
    stdout: NodeJS.WriteStream = process.stdout,
  ) {
    this.stdin = stdin;
    this.stdout = stdout;
  }

  public on<K extends keyof ProcessTerminalEvents>(
    eventName: K,
    listener: (...args: ProcessTerminalEvents[K]) => void,
  ): this {
    this.emitter.on(eventName, listener);
    return this;
  }

  public off<K extends keyof ProcessTerminalEvents>(
    eventName: K,
    listener: (...args: ProcessTerminalEvents[K]) => void,
  ): this {
    this.emitter.off(eventName, listener);
    return this;
  }

  public start(onInput: InputHandler, onResize: ResizeHandler): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.stdin.setEncoding('utf8');

    if (this.stdin.isTTY) {
      const ttyIn = this.stdin as ReadStream;
      this.restoreRawMode = Boolean(ttyIn.isRaw);
      ttyIn.setRawMode(true);
    }

    this.write(ENABLE_BRACKETED_PASTE);

    this.inputListener = (chunk: string | Buffer): void => {
      const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      onInput(data);
      this.emitter.emit('input', data);
    };

    this.resizeListener = (): void => {
      const size = this.getSize();
      onResize(size);
      this.emitter.emit('resize', size);
    };

    this.stdin.on('data', this.inputListener);
    this.stdout.on('resize', this.resizeListener);
    this.stdin.resume();
  }

  public stop(): void {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.write(DISABLE_BRACKETED_PASTE);

    if (this.inputListener) {
      this.stdin.off('data', this.inputListener);
      this.inputListener = undefined;
    }

    if (this.resizeListener) {
      this.stdout.off('resize', this.resizeListener);
      this.resizeListener = undefined;
    }

    if (this.stdin.isTTY) {
      const ttyIn = this.stdin as ReadStream;
      ttyIn.setRawMode(this.restoreRawMode);
    }
  }

  public write(data: string): void {
    this.stdout.write(data);
  }

  public getSize(): TerminalSize {
    const ttyOut = this.stdout as WriteStream;
    const cols = ttyOut.columns ?? 80;
    const rows = ttyOut.rows ?? 24;
    return { cols, rows };
  }
}
