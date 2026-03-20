import type { ApiClient } from '../../api/client-factory.js';
import { type ApiClientCapabilities, createClient, getClientCapabilities } from '../../api/client-factory.js';
import { getModeBindingCandidates, type HarnessProviderName, resolveModeBinding } from '../../core/mode-resolution.js';
import type { DduduConfig, NamedMode } from '../../core/types.js';
import { HARNESS_MODES, MODE_ORDER } from '../shared/theme.js';

interface ProviderCredentials {
  token: string;
  tokenType: string;
  source: string;
}

export const resolveProviderConfigName = (provider: string): string => {
  if (provider === 'anthropic') {
    return 'claude';
  }
  return provider;
};

export const getResolvedModeRuntime = (
  config: DduduConfig | null,
  mode: NamedMode,
  selectedModels: Record<NamedMode, string>,
  hasProvider: (provider: HarnessProviderName) => boolean,
): { mode: NamedMode; provider: string; model: string } => {
  const binding = resolveModeBinding(mode, hasProvider);
  const selected = selectedModels[mode];
  const providerName = resolveProviderConfigName(binding.provider);
  const providerConfig = config?.providers[providerName];
  const availableModels = providerConfig?.models.map((candidate) => candidate.id) ?? [];

  return {
    mode,
    provider: binding.provider,
    model: selected && availableModels.includes(selected) ? selected : binding.model,
  };
};

export const getConfiguredFallbackRuntimes = (
  config: DduduConfig | null,
  mode: NamedMode,
): Array<{ provider: string; model: string }> => {
  const configured = config?.agent.fallbacks?.[mode] ?? [];
  const parsed = configured
    .map((entry) => {
      const [provider, model] = entry.split(':');
      if (!provider || !model) {
        return null;
      }
      return { provider, model };
    })
    .filter((entry): entry is { provider: string; model: string } => Boolean(entry));
  if (parsed.length > 0) {
    return parsed;
  }
  return getModeBindingCandidates(mode).map((candidate) => ({ provider: candidate.provider, model: candidate.model }));
};

export const getNextFallbackRuntime = (
  config: DduduConfig | null,
  mode: NamedMode,
  currentProvider: string,
  currentModel: string,
  hasProvider: (provider: HarnessProviderName) => boolean,
): { provider: string; model: string } | null => {
  const candidates = getConfiguredFallbackRuntimes(config, mode).filter((candidate) => {
    if (candidate.provider === currentProvider && candidate.model === currentModel) {
      return false;
    }
    if (!hasProvider(candidate.provider as HarnessProviderName)) {
      return false;
    }
    const providerName = resolveProviderConfigName(candidate.provider);
    const models = config?.providers[providerName]?.models.map((item) => item.id) ?? [];
    return models.includes(candidate.model);
  });
  return candidates[0] ?? null;
};

export const resolveCurrentProviderModels = (config: DduduConfig | null, runtimeProvider: string): string[] => {
  if (!config) {
    return [];
  }
  const providerName = resolveProviderConfigName(runtimeProvider);
  const providerConfig = config.providers[providerName];
  return providerConfig?.models.map((model) => model.id) ?? [];
};

export const getProviderCapabilitiesFor = (
  provider: string,
  availableProviders: Map<string, ProviderCredentials>,
): ApiClientCapabilities | null => {
  const auth = availableProviders.get(provider);
  if (!auth) {
    return null;
  }
  return getClientCapabilities(provider, auth.tokenType);
};

export interface ReconfigureClientResult {
  activeClient: ApiClient | null;
  provider: string;
  model: string;
  models: string[];
  modes: Array<{ name: NamedMode; label: string; tagline: string; provider: string; model: string; active: boolean }>;
  authType: string | null;
  authSource: string | null;
  error: string | null;
}

export const reconfigureClientState = (input: {
  config: DduduConfig | null;
  currentMode: NamedMode;
  selectedModels: Record<NamedMode, string>;
  availableProviders: Map<string, ProviderCredentials>;
  permissionProfile: string;
  hasProvider: (provider: HarnessProviderName) => boolean;
}): ReconfigureClientResult => {
  const runtime = getResolvedModeRuntime(input.config, input.currentMode, input.selectedModels, input.hasProvider);
  const provider = runtime.provider;
  const model = runtime.model;
  const models = resolveCurrentProviderModels(input.config, provider);
  const modes = MODE_ORDER.map((modeName) => {
    const modeEntry = HARNESS_MODES[modeName];
    const modeRuntime = getResolvedModeRuntime(input.config, modeName, input.selectedModels, input.hasProvider);
    return {
      name: modeName,
      label: modeEntry.label,
      tagline: modeEntry.tagline,
      provider: modeRuntime.provider,
      model: modeRuntime.model,
      active: modeName === input.currentMode,
    };
  });
  const providerAuth = input.availableProviders.get(provider);
  if (providerAuth) {
    return {
      activeClient: createClient(provider, providerAuth.token, providerAuth.tokenType),
      provider,
      model,
      models,
      modes,
      authType: providerAuth.tokenType ?? null,
      authSource: providerAuth.source ?? null,
      error: null,
    };
  }
  return {
    activeClient: null,
    provider,
    model,
    models,
    modes,
    authType: null,
    authSource: null,
    error: `No auth found for ${provider}. Run: ddudu auth login`,
  };
};
