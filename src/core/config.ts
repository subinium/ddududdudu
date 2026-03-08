import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import YAML from 'yaml';

import {
  type ChecksConfig,
  type ContextBudgetConfig,
  type DduduConfig,
  type DduduConfigOverride,
  type McpConfig,
  type ModelConfig,
  type OracleConfig,
  type ProviderConfig,
  type SkillsConfig,
  type ToolsConfig,
} from './types.js';
import { getDduduPaths } from './dirs.js';

const DDUDU_PATHS = getDduduPaths();

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
  openai: {
    name: 'openai',
    command: 'openai',
    detect: 'echo openai',
    models: [
      { id: 'gpt-5.4', tier: 'expensive', default: true },
      { id: 'gpt-5.3-codex', tier: 'expensive' },
      { id: 'gpt-5.2-codex', tier: 'expensive' },
      { id: 'gpt-5.1-codex', tier: 'expensive' },
      { id: 'gpt-5.1', tier: 'expensive' },
      { id: 'gpt-5', tier: 'expensive' },
      { id: 'gpt-5.2', tier: 'expensive' },
      { id: 'gpt-4o', tier: 'medium' },
      { id: 'gpt-4o-mini', tier: 'cheap' },
    ],
  },
  gemini: {
    name: 'gemini',
    command: 'gemini',
    detect: 'echo gemini',
    models: [
      { id: 'gemini-2.5-pro', tier: 'expensive', default: true },
      { id: 'gemini-2.0-flash', tier: 'cheap' },
    ],
  },
};

const DEFAULT_CONFIG: DduduConfig = {
  providers: BUILTIN_PROVIDERS,
  agent: {
    default_provider: 'claude',
    default_model: 'claude-sonnet-4-6',
    max_turns: 50,
    timeout_minutes: 30,
  },
  tabs: {
    max_tabs: 8,
    default_layout: 'single',
    restore_on_start: true,
  },
  compaction: {
    trigger: 0.8,
    strategy: 'hierarchical',
    preserve_recent_turns: 5,
  },
  session: {
    format: 'jsonl',
    directory: DDUDU_PATHS.globalSessions,
    auto_save: true,
  },
  openclaw: {
    enabled: true,
  },
  mode: 'jennie' as const,
  git_checkpoint: true,
  drift_check: true,
  context_budget: {
    auto_detect: true,
    warn_at: 0.8,
  } as ContextBudgetConfig,
  tools: {
    permission: 'auto' as const,
    toolbox_dirs: [],
    policies: {},
  } as ToolsConfig,
  mcp: {
    servers: {},
  } as McpConfig,
  skills: {
    dirs: [],
  } as SkillsConfig,
  oracle: {
    model: 'claude-opus-4-5',
    enabled: true,
  } as OracleConfig,
  checks: {
    dirs: ['.agents/checks', '.ddudu/checks'],
  } as ChecksConfig,
};

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const deepMerge = <T>(base: T, override: unknown): T => {
  if (Array.isArray(base)) {
    return (Array.isArray(override) ? override : base) as T;
  }

  if (!isObject(base)) {
    return (override === undefined ? base : override) as T;
  }

  const result: Record<string, unknown> = { ...base };
  const source = isObject(override) ? override : {};

  for (const [key, value] of Object.entries(source)) {
    const current = result[key];

    if (isObject(current) && isObject(value)) {
      result[key] = deepMerge(current, value);
      continue;
    }

    if (Array.isArray(current)) {
      result[key] = Array.isArray(value) ? value : current;
      continue;
    }

    result[key] = value;
  }

  return result as T;
};

const interpolateEnv = (input: unknown): unknown => {
  if (typeof input === 'string') {
    return input.replace(/\$\{([A-Z0-9_]+)\}/g, (_match: string, name: string) => {
      return process.env[name] ?? '';
    });
  }

  if (Array.isArray(input)) {
    return input.map((item: unknown) => interpolateEnv(item));
  }

  if (isObject(input)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      result[key] = interpolateEnv(value);
    }
    return result;
  }

  return input;
};

const loadYamlIfExists = async (filePath: string): Promise<DduduConfigOverride> => {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    return {};
  }

  const content = await readFile(filePath, 'utf8');
  if (!content.trim()) {
    return {};
  }

  const parsed = YAML.parse(content) as unknown;
  if (!isObject(parsed)) {
    return {};
  }

  return interpolateEnv(parsed) as DduduConfigOverride;
};

const normalizeProviders = (config: DduduConfig): DduduConfig => {
  const providers: { [name: string]: ProviderConfig } = {};

  for (const [name, provider] of Object.entries(config.providers)) {
    const models: ModelConfig[] = provider.models.map((model: ModelConfig) => ({
      ...model,
      default: model.default ?? false,
    }));

    providers[name] = {
      ...provider,
      name,
      args: provider.args ?? [],
      models,
    };
  }

  return {
    ...config,
    providers,
  };
};

export const loadConfig = async (
  cliOverrides: DduduConfigOverride = {}
): Promise<DduduConfig> => {
  const userConfigPath = resolve(homedir(), '.ddudu/config.yaml');
  const localConfigPath = resolve(process.cwd(), '.ddudu/config.yaml');

  const [userConfig, localConfig] = await Promise.all([
    loadYamlIfExists(userConfigPath),
    loadYamlIfExists(localConfigPath),
  ]);

  const merged = deepMerge(
    deepMerge(deepMerge(DEFAULT_CONFIG, userConfig), localConfig),
    interpolateEnv(cliOverrides)
  );

  return normalizeProviders(merged);
};

export const resolvePreset = async (
  name: string,
  baseConfig?: DduduConfig
): Promise<DduduConfig> => {
  const config = baseConfig ?? (await loadConfig());
  const preset = config.presets?.[name];

  if (!preset) {
    return config;
  }

  const merged = deepMerge(config, preset);
  return normalizeProviders(merged);
};
