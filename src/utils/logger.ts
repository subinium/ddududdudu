export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const parseLevel = (value: string | undefined): LogLevel | null => {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }

  return null;
};

const serializeData = (data: unknown): string => {
  if (data === undefined) {
    return '';
  }

  try {
    return ` ${JSON.stringify(data)}`;
  } catch {
    return ` ${String(data)}`;
  }
};

export class Logger {
  private level: LogLevel;

  public constructor(initialLevel?: LogLevel) {
    const envLevel = parseLevel(process.env.DDUDU_LOG);
    this.level = initialLevel ?? envLevel ?? 'info';
  }

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  public log(level: LogLevel, message: string, data?: unknown): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.level]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const suffix = serializeData(data);
    process.stderr.write(
      `[DDUDU] [${level.toUpperCase()}] [${timestamp}] ${message}${suffix}\n`,
    );
  }

  public debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  public info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  public warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  public error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }
}
