import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseYaml, stringifyYaml } from '../utils/yaml.js';

import { getDduduPaths } from './dirs.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ensureRecord = (value: unknown): Record<string, unknown> => {
  return isRecord(value) ? value : {};
};

const getConfigPath = (cwd: string, scope: 'project' | 'global'): string => {
  const paths = getDduduPaths(cwd);
  return scope === 'global' ? paths.globalConfig : paths.projectConfig;
};

export const readDduduConfigOverride = async (
  cwd: string,
  scope: 'project' | 'global' = 'global',
): Promise<Record<string, unknown>> => {
  const configPath = getConfigPath(cwd, scope);
  try {
    await access(configPath, constants.R_OK);
  } catch {
    return {};
  }

  const raw = await readFile(configPath, 'utf8');
  if (!raw.trim()) {
    return {};
  }

  return ensureRecord(parseYaml(raw));
};

export const writeDduduConfigOverride = async (
  cwd: string,
  value: Record<string, unknown>,
  scope: 'project' | 'global' = 'global',
): Promise<string> => {
  const configPath = getConfigPath(cwd, scope);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, stringifyYaml(value), 'utf8');
  return configPath;
};

export const setDduduConfigValue = async (
  cwd: string,
  keyPath: string,
  value: unknown,
  scope: 'project' | 'global' = 'global',
): Promise<string> => {
  const root = await readDduduConfigOverride(cwd, scope);
  const keys = keyPath.split('.').map((part) => part.trim()).filter(Boolean);
  if (keys.length === 0) {
    throw new Error('config key cannot be empty');
  }

  let cursor = root;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index]!;
    const current = cursor[key];
    if (!isRecord(current)) {
      cursor[key] = {};
    }
    cursor = ensureRecord(cursor[key]);
  }

  cursor[keys[keys.length - 1]!] = value;
  return writeDduduConfigOverride(cwd, root, scope);
};

export const deleteDduduConfigValue = async (
  cwd: string,
  keyPath: string,
  scope: 'project' | 'global' = 'global',
): Promise<string> => {
  const root = await readDduduConfigOverride(cwd, scope);
  const keys = keyPath.split('.').map((part) => part.trim()).filter(Boolean);
  if (keys.length === 0) {
    throw new Error('config key cannot be empty');
  }

  let cursor: Record<string, unknown> | null = root;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index]!;
    const current: unknown = cursor?.[key];
    if (!isRecord(current)) {
      cursor = null;
      break;
    }
    cursor = current;
  }

  if (cursor) {
    delete cursor[keys[keys.length - 1]!];
  }

  return writeDduduConfigOverride(cwd, root, scope);
};
