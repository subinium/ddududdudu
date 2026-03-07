import { basename } from 'node:path';
import { useCallback, useEffect, useState } from 'react';

import { DEFAULT_ANTHROPIC_BASE_URL } from '../../../api/anthropic-base-url.js';
import { createClient, type ApiClient } from '../../../api/client-factory.js';
import { discoverAllProviders } from '../../../auth/discovery.js';
import { CompactionEngine } from '../../../core/compaction.js';
import { ContextBudgetManager } from '../../../core/context-budget.js';
import { DEFAULT_SYSTEM_PROMPT } from '../../../core/default-prompts.js';
import { HookRegistry } from '../../../core/hooks.js';
import { loadMemory } from '../../../core/memory.js';
import { SessionManager } from '../../../core/session.js';
import { SkillLoader } from '../../../core/skill-loader.js';
import { SubAgentPool } from '../../../core/sub-agent.js';
import type { DduduConfig, NamedMode } from '../../../core/types.js';
import { McpManager } from '../../../mcp/client.js';
import { ToolRegistry } from '../../../tools/registry.js';
import { discoverToolboxTools } from '../../../tools/toolbox.js';
import { BLACKPINK_MODES } from '../theme.js';

interface ProviderCredentials {
  token: string;
  tokenType: string;
}

export interface HarnessContext {
  isReady: boolean;
  error: string | null;
  activeClient: ApiClient | null;
  toolRegistry: ToolRegistry | null;
  sessionManager: SessionManager | null;
  sessionId: string | null;
  systemPrompt: string;
  hookRegistry: HookRegistry | null;
  skillLoader: SkillLoader | null;
  mcpManager: McpManager | null;
  compactionEngine: CompactionEngine | null;
  budgetManager: ContextBudgetManager | null;
  subAgentPool: SubAgentPool | null;
  memory: string;
  availableProviders: Map<string, { token: string; tokenType: string }>;
  switchMode: (mode: NamedMode) => void;
}

const AUTH_MISSING_MESSAGE = 'No providers configured. Run: ddudu auth login';

const normalizeProviders = (
  providers: Map<string, { token: string; tokenType: string }>
): Map<string, { token: string; tokenType: string }> => {
  const normalized = new Map<string, { token: string; tokenType: string }>(providers);

  const claude = normalized.get('claude');
  if (claude && !normalized.has('anthropic')) {
    normalized.set('anthropic', claude);
  }

  const codex = normalized.get('codex');
  if (codex && !normalized.has('openai')) {
    normalized.set('openai', codex);
  }

  return normalized;
};

const getModeConfig = (mode: NamedMode) => {
  return BLACKPINK_MODES[mode] ?? BLACKPINK_MODES.jennie;
};

const buildSystemPrompt = (mode: NamedMode): string => {
  const modeConfig = getModeConfig(mode);
  const cwd = process.cwd();
  const projectName = basename(cwd) || 'unknown-project';

  return DEFAULT_SYSTEM_PROMPT
    .replace(/\$\{model\}/g, modeConfig.model)
    .replace(/\$\{provider\}/g, modeConfig.provider)
    .replace(/\$\{cwd\}/g, cwd)
    .replace(/\$\{projectName\}/g, projectName)
    .replace(/\$\{userInstructions\}/g, modeConfig.promptAddition.trim());
};

export const useHarness = (config: DduduConfig, mode: NamedMode): HarnessContext => {
  const [currentMode, setCurrentMode] = useState<NamedMode>(mode);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeClient, setActiveClient] = useState<ApiClient | null>(null);
  const [toolRegistry, setToolRegistry] = useState<ToolRegistry | null>(null);
  const [sessionManager, setSessionManager] = useState<SessionManager | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [hookRegistry, setHookRegistry] = useState<HookRegistry | null>(null);
  const [skillLoader, setSkillLoader] = useState<SkillLoader | null>(null);
  const [mcpManager, setMcpManager] = useState<McpManager | null>(null);
  const [compactionEngine, setCompactionEngine] = useState<CompactionEngine | null>(null);
  const [budgetManager, setBudgetManager] = useState<ContextBudgetManager | null>(null);
  const [subAgentPool, setSubAgentPool] = useState<SubAgentPool | null>(null);
  const [memory, setMemory] = useState('');
  const [availableProviders, setAvailableProviders] = useState<Map<string, ProviderCredentials>>(
    new Map<string, ProviderCredentials>()
  );

  useEffect(() => {
    setCurrentMode(mode);
  }, [mode]);

  useEffect(() => {
    let isCancelled = false;
    let createdMcpManager: McpManager | null = null;

    const boot = async (): Promise<void> => {
      setIsReady(false);
      setError(null);

      const modeConfig = getModeConfig(currentMode);

      const discoveredProviders = await discoverAllProviders();
      const providerMap = normalizeProviders(
        new Map<string, ProviderCredentials>(
          Array.from(discoveredProviders.entries()).map(([provider, auth]) => [
            provider,
            { token: auth.token, tokenType: auth.tokenType },
          ])
        )
      );

      if (isCancelled) {
        return;
      }

      setAvailableProviders(providerMap);

      if (providerMap.size === 0) {
        setError(AUTH_MISSING_MESSAGE);
      }

      const providerAuth = providerMap.get(modeConfig.provider);
      if (providerAuth) {
        setActiveClient(createClient(modeConfig.provider, providerAuth.token, providerAuth.tokenType));
      } else {
        setActiveClient(null);
        setError(`No auth found for ${modeConfig.provider}. Run: ddudu auth login`);
      }

      const nextToolRegistry = new ToolRegistry();
      setToolRegistry(nextToolRegistry);

      try {
        const toolboxTools = await discoverToolboxTools();
        for (const tool of toolboxTools) {
          nextToolRegistry.register(tool);
        }
      } catch (toolboxError: unknown) {
        console.warn('[useHarness] Toolbox discovery failed.', toolboxError);
      }

      createdMcpManager = new McpManager();
      setMcpManager(createdMcpManager);

      const configuredServers = config.mcp?.servers ?? {};
      for (const [name, serverConfig] of Object.entries(configuredServers)) {
        createdMcpManager.addServer(name, serverConfig);
      }

      if (Object.keys(configuredServers).length > 0) {
        try {
          await createdMcpManager.connectAll();
        } catch (mcpError: unknown) {
          console.warn('[useHarness] MCP initialization failed.', mcpError);
        }
      }

      try {
        setMemory(await loadMemory(process.cwd()));
      } catch (memoryError: unknown) {
        console.warn('[useHarness] Memory load failed.', memoryError);
        setMemory('');
      }

      const nextSkillLoader = new SkillLoader(process.cwd());
      setSkillLoader(nextSkillLoader);

      try {
        await nextSkillLoader.scan();
      } catch (skillError: unknown) {
        console.warn('[useHarness] Skill scan failed.', skillError);
      }

      const nextHookRegistry = new HookRegistry();
      setHookRegistry(nextHookRegistry);

      const nextSessionManager = new SessionManager(config.session?.directory);
      setSessionManager(nextSessionManager);
      try {
        const session = await nextSessionManager.create({
          provider: modeConfig.provider,
          model: modeConfig.model,
        });
        if (!isCancelled) {
          setSessionId(session.id);
        }
      } catch (sessionError: unknown) {
        console.warn('[useHarness] Session initialization failed.', sessionError);
      }

      const prompt = buildSystemPrompt(currentMode);
      setSystemPrompt(prompt);

      const nextCompactionEngine = new CompactionEngine();
      setCompactionEngine(nextCompactionEngine);

      const nextBudgetManager = new ContextBudgetManager();
      setBudgetManager(nextBudgetManager);

      const anthropicAuth = providerMap.get('anthropic') ?? providerMap.get('claude');
      if (anthropicAuth) {
        const subAgentDefaultModel =
          modeConfig.provider === 'anthropic' ? modeConfig.model : 'claude-sonnet-4-6';

        setSubAgentPool(
          new SubAgentPool({
            token: anthropicAuth.token,
            baseUrl: process.env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL,
            defaultModel: subAgentDefaultModel,
            defaultSystemPrompt: prompt,
          })
        );
      } else {
        setSubAgentPool(null);
      }

      if (!isCancelled) {
        setIsReady(true);
      }
    };

    void boot().catch((bootError: unknown) => {
      if (!isCancelled) {
        const message = bootError instanceof Error ? bootError.message : 'Harness boot failed';
        setError(message);
        setIsReady(true);
      }
    });

    return () => {
      isCancelled = true;
      createdMcpManager?.disconnectAll();
    };
  }, [config]);

  useEffect(() => {
    const modeConfig = getModeConfig(currentMode);
    setSystemPrompt(buildSystemPrompt(currentMode));
    const providerAuth = availableProviders.get(modeConfig.provider);

    if (providerAuth) {
      const client = createClient(modeConfig.provider, providerAuth.token, providerAuth.tokenType);
      setActiveClient(client);
      setError((previous) => {
        if (previous?.startsWith('No auth found for')) {
          return null;
        }

        return previous;
      });
      return;
    }

    setActiveClient(null);
    setError(`No auth found for ${modeConfig.provider}. Run: ddudu auth login`);
  }, [availableProviders, currentMode]);

  const switchMode = useCallback((nextMode: NamedMode): void => {
    setCurrentMode(nextMode);
  }, []);

  return {
    isReady,
    error,
    activeClient,
    toolRegistry,
    sessionManager,
    sessionId,
    systemPrompt,
    hookRegistry,
    skillLoader,
    mcpManager,
    compactionEngine,
    budgetManager,
    subAgentPool,
    memory,
    availableProviders,
    switchMode,
  };
};
