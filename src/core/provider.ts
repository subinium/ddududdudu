import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  type ModelConfig,
  type ProviderConfig,
  type ProviderRoute,
  type ProviderStatus,
  type ProviderTask,
  type RoutingRule,
} from './types.js';

const execFileAsync = promisify(execFile);

const BUILTIN_PROVIDERS: { [name: string]: ProviderConfig } = {
  claude: {
    name: 'claude',
    command: 'claude',
    args: ['--dangerously-skip-permissions'],
    detect: 'which claude',
    models: [
      { id: 'claude-sonnet-4-6', tier: 'medium', default: true },
      { id: 'claude-opus-4-6', tier: 'expensive' },
    ],
  },
  codex: {
    name: 'codex',
    command: 'codex',
    detect: 'which codex',
    models: [{ id: 'gpt-5.4', tier: 'medium', default: true }],
  },
};

const TIER_WEIGHT: { [tier: string]: number } = {
  cheap: 0,
  medium: 1,
  expensive: 2,
};

const chooseModel = (provider: ProviderConfig, task: ProviderTask): ModelConfig => {
  if (task.preferredModel) {
    const preferredModel = provider.models.find(
      (model: ModelConfig) => model.id === task.preferredModel
    );
    if (preferredModel) {
      return preferredModel;
    }
  }

  if (task.priority === 'cheap') {
    return provider.models.reduce((best: ModelConfig, candidate: ModelConfig) => {
      return TIER_WEIGHT[candidate.tier] < TIER_WEIGHT[best.tier] ? candidate : best;
    }, provider.models[0]);
  }

  if (task.priority === 'quality') {
    return provider.models.reduce((best: ModelConfig, candidate: ModelConfig) => {
      return TIER_WEIGHT[candidate.tier] > TIER_WEIGHT[best.tier] ? candidate : best;
    }, provider.models[0]);
  }

  return (
    provider.models.find((model: ModelConfig) => model.default === true) ?? provider.models[0]
  );
};

const matchesRule = (rule: RoutingRule, task: ProviderTask): boolean => {
  if (rule.match_task_type && rule.match_task_type !== task.taskType) {
    return false;
  }

  if (rule.match_priority && rule.match_priority !== task.priority) {
    return false;
  }

  return true;
};

export class ProviderRegistry {
  private readonly providers: Map<string, ProviderConfig>;
  private readonly routingRules: RoutingRule[];
  private readonly defaultProviderName: string;

  public constructor(options?: {
    providers?: { [name: string]: ProviderConfig };
    routingRules?: RoutingRule[];
    defaultProvider?: string;
  }) {
    this.providers = new Map<string, ProviderConfig>();
    this.routingRules = options?.routingRules ?? [];
    this.defaultProviderName = options?.defaultProvider ?? 'claude';

    for (const provider of Object.values(BUILTIN_PROVIDERS)) {
      this.register(provider);
    }

    if (options?.providers) {
      for (const provider of Object.values(options.providers)) {
        this.register(provider);
      }
    }
  }

  public register(config: ProviderConfig): void {
    const normalizedProvider: ProviderConfig = {
      ...config,
      name: config.name,
      args: config.args ?? [],
      models: config.models,
    };

    this.providers.set(normalizedProvider.name, normalizedProvider);
  }

  public async detect(): Promise<ProviderStatus[]> {
    const providerList = Array.from(this.providers.values());
    return Promise.all(
      providerList.map(async (provider: ProviderConfig): Promise<ProviderStatus> => {
        return this.check(provider.name);
      })
    );
  }

  public async check(name: string): Promise<ProviderStatus> {
    const provider = this.providers.get(name);
    if (!provider) {
      return {
        name,
        available: false,
        checkedAt: new Date().toISOString(),
        error: `Provider not registered: ${name}`,
      };
    }

    try {
      const { stdout } = await execFileAsync('which', [provider.command]);
      const commandPath = stdout.trim();

      return {
        name: provider.name,
        available: commandPath.length > 0,
        commandPath,
        checkedAt: new Date().toISOString(),
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown detection error';
      return {
        name: provider.name,
        available: false,
        checkedAt: new Date().toISOString(),
        error: errorMessage,
      };
    }
  }

  public async route(task: ProviderTask = {}): Promise<ProviderRoute> {
    const selectedProvider = await this.selectProvider(task);
    const model = chooseModel(selectedProvider, task);

    return {
      provider: selectedProvider,
      model,
      reason: this.buildReason(selectedProvider, model, task),
    };
  }

  private async selectProvider(task: ProviderTask): Promise<ProviderConfig> {
    const preferred = task.preferredProvider
      ? this.providers.get(task.preferredProvider)
      : undefined;

    if (preferred) {
      if (!task.requireAvailable) {
        return preferred;
      }

      const status = await this.check(preferred.name);
      if (status.available) {
        return preferred;
      }
    }

    for (const rule of this.routingRules) {
      if (!matchesRule(rule, task)) {
        continue;
      }

      const provider = this.providers.get(rule.provider);
      if (!provider) {
        continue;
      }

      if (!task.requireAvailable) {
        return provider;
      }

      const status = await this.check(provider.name);
      if (status.available) {
        return provider;
      }
    }

    const defaultProvider = this.providers.get(this.defaultProviderName);
    if (!defaultProvider) {
      throw new Error(`Default provider not found: ${this.defaultProviderName}`);
    }

    if (!task.requireAvailable) {
      return defaultProvider;
    }

    const defaultStatus = await this.check(defaultProvider.name);
    if (defaultStatus.available) {
      return defaultProvider;
    }

    const allStatuses = await this.detect();
    const available = allStatuses.find((status: ProviderStatus) => status.available);
    if (available) {
      const fallbackProvider = this.providers.get(available.name);
      if (fallbackProvider) {
        return fallbackProvider;
      }
    }

    throw new Error('No available provider detected');
  }

  private buildReason(
    provider: ProviderConfig,
    model: ModelConfig,
    task: ProviderTask
  ): string {
    if (task.preferredProvider === provider.name) {
      return `Selected preferred provider ${provider.name} with model ${model.id}`;
    }

    if (task.priority) {
      return `Selected ${provider.name}/${model.id} for ${task.priority} priority`;
    }

    return `Selected ${provider.name}/${model.id} using default routing`;
  }
}
