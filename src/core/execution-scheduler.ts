import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface ExecutionSchedulerConfig {
  providerBudgets: Record<string, number>;
  maxParallelWrites: number;
  pollMs: number;
  staleMs: number;
}

export interface ExecutionLease {
  release(): Promise<void>;
}

export interface ExecutionAcquireOptions {
  provider?: string | null;
  writeKey?: string | null;
  signal?: AbortSignal;
  onWait?: (message: string) => void;
}

const DEFAULT_PROVIDER_BUDGETS: Record<string, number> = {
  anthropic: 4,
  claude: 4,
  openai: 4,
  codex: 4,
  gemini: 2,
};

const normalizeProviderKey = (provider: string): string => {
  if (provider === 'claude') {
    return 'anthropic';
  }
  if (provider === 'codex') {
    return 'openai';
  }
  return provider;
};

const slug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';

const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) {
    throw new Error('Execution acquisition aborted.');
  }

  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Execution acquisition aborted.'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const leaseBaseDir = (): string => resolve(homedir(), '.ddudu', 'runtime', 'leases');

const isStaleLease = async (leasePath: string, staleMs: number): Promise<boolean> => {
  try {
    const info = await stat(leasePath);
    return Date.now() - info.mtimeMs > staleMs;
  } catch {
    return false;
  }
};

const writeLeaseMetadata = async (leasePath: string): Promise<void> => {
  await writeFile(
    resolve(leasePath, 'meta.json'),
    JSON.stringify(
      {
        pid: process.pid,
        createdAt: Date.now(),
      },
      null,
      2,
    ),
    'utf8',
  );
};

export class ExecutionScheduler {
  private readonly config: ExecutionSchedulerConfig;

  public constructor(config: Partial<ExecutionSchedulerConfig> = {}) {
    this.config = {
      providerBudgets: {
        ...DEFAULT_PROVIDER_BUDGETS,
        ...(config.providerBudgets ?? {}),
      },
      maxParallelWrites: Math.max(1, config.maxParallelWrites ?? 4),
      pollMs: Math.max(25, config.pollMs ?? 125),
      staleMs: Math.max(5_000, config.staleMs ?? 10 * 60_000),
    };
  }

  public async acquire(options: ExecutionAcquireOptions): Promise<ExecutionLease> {
    const releases: Array<() => Promise<void>> = [];

    try {
      if (options.provider) {
        const providerRelease = await this.acquireProviderSlot(
          normalizeProviderKey(options.provider),
          options.signal,
          options.onWait,
        );
        releases.push(providerRelease);
      }

      if (options.writeKey) {
        const writeRelease = await this.acquireWriteSlot(options.writeKey, options.signal, options.onWait);
        releases.push(writeRelease);
      }

      return {
        release: async () => {
          while (releases.length > 0) {
            const release = releases.pop();
            if (release) {
              await release();
            }
          }
        },
      };
    } catch (error) {
      while (releases.length > 0) {
        const release = releases.pop();
        if (release) {
          await release().catch(() => undefined);
        }
      }
      throw error;
    }
  }

  private async acquireProviderSlot(
    provider: string,
    signal?: AbortSignal,
    onWait?: (message: string) => void,
  ): Promise<() => Promise<void>> {
    const capacity = Math.max(1, this.config.providerBudgets[provider] ?? 2);
    const providerDir = resolve(leaseBaseDir(), 'providers', provider);
    await mkdir(providerDir, { recursive: true });

    while (true) {
      if (signal?.aborted) {
        throw new Error(`Provider slot acquisition aborted for ${provider}.`);
      }

      for (let index = 0; index < capacity; index += 1) {
        const slotDir = resolve(providerDir, `slot-${index + 1}`);
        try {
          await mkdir(slotDir);
          await writeLeaseMetadata(slotDir);
          return async () => {
            await rm(slotDir, { recursive: true, force: true });
          };
        } catch {
          if (await isStaleLease(slotDir, this.config.staleMs)) {
            await rm(slotDir, { recursive: true, force: true }).catch(() => undefined);
            continue;
          }
        }
      }

      onWait?.(`waiting for ${provider} provider slot`);
      await sleep(this.config.pollMs, signal);
    }
  }

  private async acquireWriteSlot(
    writeKey: string,
    signal?: AbortSignal,
    onWait?: (message: string) => void,
  ): Promise<() => Promise<void>> {
    const repoKey = slug(writeKey);
    const writeDir = resolve(leaseBaseDir(), 'writes', repoKey);
    await mkdir(writeDir, { recursive: true });

    while (true) {
      if (signal?.aborted) {
        throw new Error(`Write slot acquisition aborted for ${writeKey}.`);
      }

      for (let index = 0; index < this.config.maxParallelWrites; index += 1) {
        const slotDir = resolve(writeDir, `slot-${index + 1}`);
        try {
          await mkdir(slotDir);
          await writeLeaseMetadata(slotDir);
          return async () => {
            await rm(slotDir, { recursive: true, force: true });
          };
        } catch {
          if (await isStaleLease(slotDir, this.config.staleMs)) {
            await rm(slotDir, { recursive: true, force: true }).catch(() => undefined);
            continue;
          }
        }
      }

      onWait?.('waiting for write workspace slot');
      await sleep(this.config.pollMs, signal);
    }
  }
}

export const deriveExecutionSchedulerConfig = (input: {
  providerBudgets?: Record<string, number> | undefined;
  maxParallelWrites?: number | undefined;
  pollMs?: number | undefined;
}): ExecutionSchedulerConfig => ({
  providerBudgets: {
    ...DEFAULT_PROVIDER_BUDGETS,
    ...(input.providerBudgets ?? {}),
  },
  maxParallelWrites: Math.max(1, input.maxParallelWrites ?? 4),
  pollMs: Math.max(25, input.pollMs ?? 125),
  staleMs: 10 * 60_000,
});
