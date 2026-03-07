import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import YAML from 'yaml';

import {
  BOLD,
  DIM,
  GREEN,
  PINK,
  RED,
  RESET,
  WHITE_BRIGHT,
  YELLOW,
} from './colors.js';
import { discoverAllProviders, type ProviderAuth } from '../auth/discovery.js';

const CONFIG_DIR = join(homedir(), '.ddudu');
const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');
const PROVIDERS = ['claude', 'codex', 'gemini'] as const;

interface ConfigWithAuth {
  auth?: {
    default_provider?: string;
    providers?: {
      [name: string]: {
        token: string;
        source: string;
        token_type: string;
      };
    };
  };
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const clearScreen = (): void => {
  process.stdout.write('\x1b[2J\x1b[H');
};

const providerLabel = (provider: string): string => {
  if (provider === 'claude') {
    return 'Claude';
  }

  if (provider === 'codex') {
    return 'Codex';
  }

  return 'Gemini';
};

const renderProviderStatus = (provider: string, auth: ProviderAuth | null): void => {
  const label = providerLabel(provider);
  if (!auth) {
    process.stdout.write(` ${RED}✗${RESET} ${WHITE_BRIGHT}${label}${RESET} ${DIM}(not detected)${RESET}\n`);
    return;
  }

  process.stdout.write(
    ` ${GREEN}✓${RESET} ${WHITE_BRIGHT}${label}${RESET} ${DIM}${auth.source} · ${auth.tokenType}${RESET}\n`,
  );
};

const readConfig = async (): Promise<ConfigWithAuth> => {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const parsed = YAML.parse(raw) as unknown;
    if (isRecord(parsed)) {
      return parsed as ConfigWithAuth;
    }
    return {};
  } catch (err: unknown) {
    void err;
    return {};
  }
};

const saveConfig = async (providers: Map<string, ProviderAuth>): Promise<void> => {
  const current = await readConfig();
  const existingProviders = isRecord(current.auth?.providers)
    ? (current.auth?.providers as Record<string, unknown>)
    : {};

  const mergedProviders: Record<
    string,
    {
      token: string;
      source: string;
      token_type: string;
    }
  > = {};

  for (const [name, value] of Object.entries(existingProviders)) {
    if (!isRecord(value)) {
      continue;
    }

    const token = typeof value.token === 'string' ? value.token : '';
    const source = typeof value.source === 'string' ? value.source : 'unknown';
    const tokenType = typeof value.token_type === 'string' ? value.token_type : 'apikey';

    if (!token) {
      continue;
    }

    mergedProviders[name] = {
      token,
      source,
      token_type: tokenType,
    };
  }

  for (const [name, auth] of providers.entries()) {
    mergedProviders[name] = {
      token: auth.token,
      source: auth.source,
      token_type: auth.tokenType,
    };
  }

  const defaultProvider =
    PROVIDERS.find((provider) => Boolean(mergedProviders[provider])) ?? current.auth?.default_provider;

  const nextConfig: ConfigWithAuth = {
    ...current,
    auth: {
      ...(isRecord(current.auth) ? current.auth : {}),
      default_provider: defaultProvider,
      providers: mergedProviders,
    },
  };

  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, YAML.stringify(nextConfig), 'utf8');
};

const askManualKeys = async (
  detected: Map<string, ProviderAuth>,
  missingProviders: string[],
): Promise<Map<string, ProviderAuth>> => {
  const updated = new Map<string, ProviderAuth>(detected);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      `${YELLOW}?${RESET} Enter API keys manually for missing providers? ${DIM}(y/N)${RESET} `,
    );
    const normalized = answer.trim().toLowerCase();
    if (normalized !== 'y' && normalized !== 'yes') {
      return updated;
    }

    for (const provider of missingProviders) {
      const label = providerLabel(provider);
      const key = await rl.question(`${PINK}→${RESET} ${label} API key: `);
      const token = key.trim();
      if (!token) {
        continue;
      }

      const tokenType = provider === 'gemini' ? 'apikey' : 'apikey';
      updated.set(provider, {
        provider,
        token,
        source: 'manual-wizard',
        tokenType,
      });
    }
  } finally {
    rl.close();
  }

  return updated;
};

export const needsWizard = async (): Promise<boolean> => {
  try {
    await access(CONFIG_PATH, constants.R_OK);
  } catch (err: unknown) {
    void err;
    return true;
  }

  const config = await readConfig();
  const providers = config.auth?.providers;
  if (!providers || !isRecord(providers)) {
    return true;
  }

  for (const value of Object.values(providers)) {
    if (!isRecord(value)) {
      continue;
    }

    if (typeof value.token === 'string' && value.token.trim()) {
      return false;
    }
  }

  return true;
};

export const runWizard = async (): Promise<void> => {
  clearScreen();
  process.stdout.write(`${PINK}${BOLD}Welcome to ddudu! Let's set up your providers.${RESET}\n\n`);
  process.stdout.write(`${DIM}Step 1) Check Claude (auto-detect)${RESET}\n`);
  process.stdout.write(`${DIM}Step 2) Check Codex (auto-detect)${RESET}\n`);
  process.stdout.write(`${DIM}Step 3) Check Gemini (auto-detect)${RESET}\n`);
  process.stdout.write(`${DIM}Step 4) Manual API key entry (optional)${RESET}\n\n`);

  const detected = await discoverAllProviders();

  renderProviderStatus('claude', detected.get('claude') ?? null);
  renderProviderStatus('codex', detected.get('codex') ?? null);
  renderProviderStatus('gemini', detected.get('gemini') ?? null);

  const missing = PROVIDERS.filter((provider) => !detected.has(provider));
  const finalProviders =
    missing.length > 0 ? await askManualKeys(detected, [...missing]) : new Map(detected);

  await saveConfig(finalProviders);

  process.stdout.write('\n');
  process.stdout.write(`${GREEN}✓${RESET} Saved auth configuration to ${WHITE_BRIGHT}${CONFIG_PATH}${RESET}\n`);

  if (finalProviders.size === 0) {
    process.stdout.write(
      `${YELLOW}!${RESET} No providers configured yet. Re-run wizard after authenticating a provider.\n`,
    );
    return;
  }

  process.stdout.write(`${GREEN}✓${RESET} Setup complete. You can now launch ddudu.\n`);
};
