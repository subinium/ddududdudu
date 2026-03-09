import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { parseYaml, stringifyYaml } from '../utils/yaml.js';

import type { AuthProviderName } from './login.js';

export interface StoredProviderAuth {
  token: string;
  tokenType: 'apikey' | 'oauth' | 'bearer';
  source: string;
  label?: string;
  updatedAt: string;
}

type AuthStoreShape = Partial<Record<AuthProviderName, StoredProviderAuth>>;

const resolveAuthStorePath = (): string => {
  const dduduHome = process.env.DDUDU_HOME?.trim();
  if (dduduHome) {
    return resolve(dduduHome, 'auth.yaml');
  }

  return resolve(homedir(), '.ddudu', 'auth.yaml');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseStoredProviderAuth = (value: unknown): StoredProviderAuth | null => {
  if (!isRecord(value)) {
    return null;
  }

  const token = typeof value.token === 'string' ? value.token.trim() : '';
  const tokenType =
    value.tokenType === 'apikey' || value.tokenType === 'oauth' || value.tokenType === 'bearer'
      ? value.tokenType
      : null;
  const source = typeof value.source === 'string' ? value.source.trim() : '';
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString();

  if (!token || !tokenType || !source) {
    return null;
  }

  return {
    token,
    tokenType,
    source,
    label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : undefined,
    updatedAt,
  };
};

export const readAuthStore = async (): Promise<AuthStoreShape> => {
  const filePath = resolveAuthStorePath();
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = parseYaml(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }

    const result: AuthStoreShape = {};
    for (const provider of ['claude', 'codex', 'gemini'] as const) {
      const stored = parseStoredProviderAuth(parsed[provider]);
      if (stored) {
        result[provider] = stored;
      }
    }
    return result;
  } catch {
    return {};
  }
};

export const getStoredProviderAuth = async (
  provider: AuthProviderName,
): Promise<StoredProviderAuth | null> => {
  const store = await readAuthStore();
  return store[provider] ?? null;
};

export const setStoredProviderAuth = async (
  provider: AuthProviderName,
  auth: Omit<StoredProviderAuth, 'updatedAt'>,
): Promise<string> => {
  const filePath = resolveAuthStorePath();
  const store = await readAuthStore();
  store[provider] = {
    ...auth,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, stringifyYaml(store), 'utf8');
  return filePath;
};

export const deleteStoredProviderAuth = async (provider: AuthProviderName): Promise<string> => {
  const filePath = resolveAuthStorePath();
  const store = await readAuthStore();
  delete store[provider];
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, stringifyYaml(store), 'utf8');
  return filePath;
};

export const getAuthStorePath = (): string => resolveAuthStorePath();
