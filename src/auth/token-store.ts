import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { KeyringStore } from './keyring.js';

interface TokenStoreConfig {
  providers: string[];
  tokens: Record<string, string>;
}

interface TokenStoreOptions {
  serviceName?: string;
  configPath?: string;
  keyring?: KeyringStore;
}

const DEFAULT_SERVICE_NAME = 'ddudu.tokens';
const DEFAULT_CONFIG_PATH = join(homedir(), '.ddudu', 'tokens.json');

const toEnvKey = (provider: string): string => {
  const normalized = provider.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `${normalized}_API_KEY`;
};

const fromEnvKey = (envKey: string): string | null => {
  const match = envKey.match(/^([A-Z0-9_]+)_API_KEY$/);
  if (!match) {
    return null;
  }

  const normalized = match[1].replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!normalized) {
    return null;
  }

  return normalized.toLowerCase();
};

export class TokenStore {
  private readonly keyring: KeyringStore;

  private readonly serviceName: string;

  private readonly configPath: string;

  public constructor(options: TokenStoreOptions = {}) {
    this.keyring = options.keyring ?? new KeyringStore();
    this.serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
    this.configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  }

  public async resolve(provider: string): Promise<string | null> {
    const normalizedProvider = provider.trim().toLowerCase();
    if (!normalizedProvider) {
      throw new Error('Provider must be a non-empty string.');
    }

    const envKey = toEnvKey(normalizedProvider);
    const envToken = process.env[envKey]?.trim();
    if (envToken) {
      return envToken;
    }

    const keyringToken = await this.keyring.get(this.serviceName, normalizedProvider);
    if (keyringToken) {
      return keyringToken;
    }

    const config = await this.readConfig();
    const fileToken = config.tokens[normalizedProvider]?.trim();
    if (fileToken) {
      return fileToken;
    }

    throw new Error(
      `No token found for provider "${normalizedProvider}" in ${envKey}, keyring, or ${this.configPath}.`,
    );
  }

  public async store(provider: string, token: string): Promise<void> {
    const normalizedProvider = provider.trim().toLowerCase();
    const trimmedToken = token.trim();

    if (!normalizedProvider) {
      throw new Error('Provider must be a non-empty string.');
    }

    if (!trimmedToken) {
      throw new Error('Token must be a non-empty string.');
    }

    let keyringStored = false;
    try {
      await this.keyring.set(this.serviceName, normalizedProvider, trimmedToken);
      keyringStored = true;
    } catch {
      keyringStored = false;
    }

    const config = await this.readConfig();
    config.providers = this.ensureProvider(config.providers, normalizedProvider);

    if (keyringStored) {
      delete config.tokens[normalizedProvider];
    } else {
      config.tokens[normalizedProvider] = trimmedToken;
    }

    await this.writeConfig(config);
  }

  public async listProviders(): Promise<string[]> {
    const config = await this.readConfig();
    const providers = new Set<string>();

    for (const provider of config.providers) {
      providers.add(provider);
    }

    for (const [envKey, envValue] of Object.entries(process.env)) {
      if (!envValue || !envValue.trim()) {
        continue;
      }

      const provider = fromEnvKey(envKey);
      if (provider) {
        providers.add(provider);
      }
    }

    const providerList = Array.from(providers);
    const checks = await Promise.all(
      providerList.map(async (providerName): Promise<boolean> => {
        if (config.tokens[providerName]?.trim()) {
          return true;
        }

        if (process.env[toEnvKey(providerName)]?.trim()) {
          return true;
        }

        const keyringValue = await this.keyring.get(this.serviceName, providerName);
        return Boolean(keyringValue);
      }),
    );

    return providerList.filter((_, index) => checks[index]).sort();
  }

  private ensureProvider(providers: string[], provider: string): string[] {
    if (providers.includes(provider)) {
      return providers;
    }

    return [...providers, provider];
  }

  private async readConfig(): Promise<TokenStoreConfig> {
    try {
      const raw = await readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<TokenStoreConfig>;

      const providerList = Array.isArray(parsed.providers)
        ? parsed.providers.filter(
            (provider): provider is string =>
              typeof provider === 'string' && provider.trim().length > 0,
          )
        : [];

      const tokens: Record<string, string> = {};
      if (parsed.tokens && typeof parsed.tokens === 'object') {
        for (const [provider, storedToken] of Object.entries(parsed.tokens)) {
          if (typeof storedToken === 'string' && storedToken.trim().length > 0) {
            tokens[provider.trim().toLowerCase()] = storedToken;
          }
        }
      }

      for (const provider of providerList) {
        if (tokens[provider] || tokens[provider.toLowerCase()]) {
          continue;
        }
      }

      return {
        providers: providerList.map((provider) => provider.trim().toLowerCase()),
        tokens,
      };
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { providers: [], tokens: {} };
      }

      throw new Error(`Failed to read token config at ${this.configPath}: ${String(error)}`);
    }
  }

  private async writeConfig(config: TokenStoreConfig): Promise<void> {
    const directory = dirname(this.configPath);
    await mkdir(directory, { recursive: true });

    const payload = {
      providers: Array.from(new Set(config.providers)).sort(),
      tokens: config.tokens,
    };

    await writeFile(this.configPath, JSON.stringify(payload, null, 2), 'utf8');
  }
}
