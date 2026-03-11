export interface ExecutionSchedulerConfig {
  providerBudgets: Record<string, number>;
  resourceBudgets: Record<string, number>;
  maxParallelWrites: number;
  pollMs?: number;
  staleMs?: number;
}

export interface ExecutionLease {
  release(): Promise<void>;
}

export interface ExecutionAcquireOptions {
  provider?: string | null;
  resource?: string | null;
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

const DEFAULT_RESOURCE_BUDGETS: Record<string, number> = {
  search: 8,
  verification: 2,
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

const normalizeResourceKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';

const EXECUTION_ABORT_MESSAGE = 'Execution acquisition aborted.';

interface WaitEntry {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class InMemorySemaphore {
  private current = 0;

  private readonly capacity: number;

  private readonly waitQueue: WaitEntry[] = [];

  public constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  public isSaturated(): boolean {
    return this.current >= this.capacity;
  }

  public async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new Error(EXECUTION_ABORT_MESSAGE);
    }

    if (!this.isSaturated()) {
      this.current += 1;
      return this.createRelease();
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry: WaitEntry = {
        resolve: () => {
          this.current += 1;
          if (entry.signal && entry.onAbort) {
            entry.signal.removeEventListener('abort', entry.onAbort);
          }
          resolve(this.createRelease());
        },
        reject: (error: Error) => {
          if (entry.signal && entry.onAbort) {
            entry.signal.removeEventListener('abort', entry.onAbort);
          }
          reject(error);
        },
      };

      if (signal) {
        const onAbort = (): void => {
          const index = this.waitQueue.indexOf(entry);
          if (index >= 0) {
            this.waitQueue.splice(index, 1);
          }
          entry.reject(new Error(EXECUTION_ABORT_MESSAGE));
        };

        entry.signal = signal;
        entry.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.waitQueue.push(entry);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.release();
    };
  }

  private release(): void {
    this.current = Math.max(0, this.current - 1);
    const next = this.waitQueue.shift();
    if (next) {
      next.resolve();
    }
  }
}

const throwAbortError = (signal: AbortSignal | undefined, message: string, error: unknown): never => {
  if (signal?.aborted) {
    throw new Error(message);
  }

  if (error instanceof Error && error.message === EXECUTION_ABORT_MESSAGE) {
    throw new Error(message);
  }

  throw error;
};

export class ExecutionScheduler {
  private readonly providerSemaphores = new Map<string, InMemorySemaphore>();

  private readonly resourceSemaphores = new Map<string, InMemorySemaphore>();

  private readonly writeSemaphore: InMemorySemaphore;

  private readonly config: ExecutionSchedulerConfig;

  public constructor(config: Partial<ExecutionSchedulerConfig> = {}) {
    this.config = deriveExecutionSchedulerConfig(config);
    this.writeSemaphore = new InMemorySemaphore(this.config.maxParallelWrites);
  }

  public async acquire(options: ExecutionAcquireOptions): Promise<ExecutionLease> {
    const releases: Array<() => void> = [];

    try {
      if (options.provider) {
        const providerKey = normalizeProviderKey(options.provider);
        const providerSemaphore = this.getProviderSemaphore(providerKey);
        if (providerSemaphore.isSaturated()) {
          options.onWait?.(`waiting for ${providerKey} provider slot`);
        }
        const providerRelease = await providerSemaphore
          .acquire(options.signal)
          .catch((error: unknown) =>
            throwAbortError(options.signal, `Provider slot acquisition aborted for ${providerKey}.`, error),
          );
        releases.push(providerRelease);
      }

      if (options.resource) {
        const resourceKey = normalizeResourceKey(options.resource);
        const resourceSemaphore = this.getResourceSemaphore(resourceKey, options.resource);
        if (resourceSemaphore.isSaturated()) {
          options.onWait?.(`waiting for ${resourceKey} slot`);
        }
        const resourceRelease = await resourceSemaphore
          .acquire(options.signal)
          .catch((error: unknown) =>
            throwAbortError(options.signal, `Resource slot acquisition aborted for ${resourceKey}.`, error),
          );
        releases.push(resourceRelease);
      }

      if (options.writeKey) {
        if (this.writeSemaphore.isSaturated()) {
          options.onWait?.('waiting for write workspace slot');
        }
        const writeRelease = await this.writeSemaphore
          .acquire(options.signal)
          .catch((error: unknown) =>
            throwAbortError(options.signal, `Write slot acquisition aborted for ${options.writeKey}.`, error),
          );
        releases.push(writeRelease);
      }

      return {
        release: async () => {
          while (releases.length > 0) {
            const release = releases.pop();
            if (release) {
              release();
            }
          }
        },
      };
    } catch (error) {
      while (releases.length > 0) {
        const release = releases.pop();
        if (release) {
          try {
            release();
          } catch {}
        }
      }
      throw error;
    }
  }

  private getProviderSemaphore(provider: string): InMemorySemaphore {
    let semaphore = this.providerSemaphores.get(provider);
    if (!semaphore) {
      const capacity = Math.max(1, this.config.providerBudgets[provider] ?? 2);
      semaphore = new InMemorySemaphore(capacity);
      this.providerSemaphores.set(provider, semaphore);
    }
    return semaphore;
  }

  private getResourceSemaphore(resourceKey: string, originalResource: string): InMemorySemaphore {
    let semaphore = this.resourceSemaphores.get(resourceKey);
    if (!semaphore) {
      const normalizedBudget = this.config.resourceBudgets[resourceKey];
      const originalBudget = this.config.resourceBudgets[originalResource];
      const capacity = Math.max(1, normalizedBudget ?? originalBudget ?? 2);
      semaphore = new InMemorySemaphore(capacity);
      this.resourceSemaphores.set(resourceKey, semaphore);
    }
    return semaphore;
  }
}

export const deriveExecutionSchedulerConfig = (input: {
  providerBudgets?: Record<string, number> | undefined;
  resourceBudgets?: Record<string, number> | undefined;
  maxParallelWrites?: number | undefined;
  pollMs?: number | undefined;
  staleMs?: number | undefined;
}): ExecutionSchedulerConfig => {
  const capacity = Math.max(
    1,
    input.maxParallelWrites ?? 4,
  );

  return {
    providerBudgets: {
      ...DEFAULT_PROVIDER_BUDGETS,
      ...(input.providerBudgets ?? {}),
    },
    resourceBudgets: {
      ...DEFAULT_RESOURCE_BUDGETS,
      ...(input.resourceBudgets ?? {}),
    },
    maxParallelWrites: capacity,
  };
};
