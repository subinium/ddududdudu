export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

// TODO(security): Add request-level API rate limiting; current logic only retries after failures.

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 16_000,
};

const RETRYABLE_STATUS_PATTERNS = [
  /429/,
  /rate.?limit/i,
  /too many requests/i,
  /overloaded/i,
  /503/,
  /502/,
  /500/,
  /server.?error/i,
  /timeout/i,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /fetch.?failed/i,
];

const AUTH_ERROR_PATTERNS = [
  /401/,
  /403/,
  /unauthorized/i,
  /forbidden/i,
  /invalid.?api.?key/i,
  /authentication/i,
  /expired.?token/i,
  /invalid.?token/i,
];

export type ErrorCategory = 'retryable' | 'auth' | 'fatal';

export const classifyError = (error: unknown): ErrorCategory => {
  const message = error instanceof Error ? error.message : String(error);

  for (const pattern of AUTH_ERROR_PATTERNS) {
    if (pattern.test(message)) return 'auth';
  }

  for (const pattern of RETRYABLE_STATUS_PATTERNS) {
    if (pattern.test(message)) return 'retryable';
  }

  return 'fatal';
};

export const computeBackoffMs = (attempt: number, config: RetryConfig = DEFAULT_RETRY_CONFIG): number => {
  const jitter = Math.random() * 0.3 + 0.85;
  const delay = config.baseDelayMs * 2 ** attempt * jitter;
  return Math.min(delay, config.maxDelayMs);
};

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
