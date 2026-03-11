import { getDduduPaths } from '../../../core/dirs.js';
import { deleteDduduConfigValue, setDduduConfigValue } from '../../../core/config-editor.js';
import { loadConfig } from '../../../core/config.js';
import { initializeProject } from '../../../core/project-init.js';
import { SkillLoader, type LoadedSkill } from '../../../core/skill-loader.js';
import { loadHookFiles } from '../../../core/hook-loader.js';
import { formatArtifactContextLine } from '../../../core/artifacts.js';
import { HARNESS_MODES } from '../../shared/theme.js';

const previewText = (value: string, maxLength: number = 96): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const serializeError = (error: unknown): string => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
};

const isTrustTier = (value: unknown): value is 'trusted' | 'ask' | 'deny' => {
  return value === 'trusted' || value === 'ask' || value === 'deny';
};

export interface SystemCommandDeps {
  currentMode: 'jennie' | 'lisa' | 'rosé' | 'jisoo';
  state: {
    authType: string | null;
    provider: string;
    model: string;
    sessionId: string | null;
    authSource: string | null;
    contextTokens: number;
    contextLimit: number;
    contextPercent: number;
    workspace: { path: string } | null;
  };
  permissionProfile: string;
  todos: Array<{ status: string; step: string }>;
  loadedSkills: Map<string, LoadedSkill>;
  toolRegistry: { list: () => Array<{ name: string }> } | null;
  lspManager: { getServerState: () => { connected: unknown[]; available: unknown[] } };
  queuedPrompts: string[];
  artifacts: Array<{ mode?: 'jennie' | 'lisa' | 'rosé' | 'jisoo' }>;
  remoteSessions: Map<string, unknown>;
  backgroundJobs: Array<{ status: string; updatedAt: number; label: string; detail?: string | null }>;
  getContextProfile: () => { canonicalWorkingSetTokens: number; autoCompactAtTokens: number };
  getChangedFiles: (limit: number) => Promise<string[]>;
  getBriefingSummary: () => Promise<{ summary: string; nextSteps: string[] } | null>;
  agentActivities: Array<{
    mode?: 'jennie' | 'lisa' | 'rosé' | 'jisoo' | null;
    label: string;
    purpose?: string | null;
    status: string;
    detail?: string | null;
    updatedAt: number;
  }>;
  epistemicState: {
    getStats: () => { uncertainties: number };
  };
  refreshSystemPrompt: () => Promise<void>;
  scheduleStatePush: () => void;
  mcpManager: { getConnectedServers: () => string[] } | null;
  config: {
    mcp: {
      servers: Record<string, { command: string; enabled?: boolean; trust?: string }>;
    };
  } | null;
  reloadMcpRuntime: () => Promise<void>;
  setMcpServerEnabled: (name: string, enabled: boolean) => Promise<void>;
  setMcpServerTrust: (name: string, trust: 'trusted' | 'ask' | 'deny') => Promise<void>;
  hookRegistry: { stats: () => Record<string, number>; clear: () => void };
}

export const formatConfigSummary = (deps: SystemCommandDeps): string => {
  const modeEntry = HARNESS_MODES[deps.currentMode] ?? HARNESS_MODES.jennie;
  const authLabel = deps.state.authType ?? 'missing';

  return [
    'Runtime config',
    `mode: ${modeEntry.label} (${modeEntry.tagline})`,
    `provider: ${deps.state.provider}`,
    `model: ${deps.state.model}`,
    `auth: ${authLabel}`,
    `permissions: ${deps.permissionProfile}`,
    `session: ${deps.state.sessionId ?? 'none'}`,
    `plan items: ${deps.todos.length}`,
    `skills loaded: ${deps.loadedSkills.size}`,
    `tools: ${deps.toolRegistry?.list().length ?? 0}`,
  ].join('\n');
};

export const formatDoctorSummary = (deps: SystemCommandDeps): string => {
  const profile = deps.getContextProfile();
  const queue = deps.queuedPrompts.length > 0 ? deps.queuedPrompts.length.toString() : '0';
  const lspState = deps.lspManager.getServerState();

  return [
    'Doctor',
    `provider: ${deps.state.provider}`,
    `model: ${deps.state.model}`,
    `auth: ${deps.state.authType ?? 'missing'}${deps.state.authSource ? ` via ${deps.state.authSource}` : ''}`,
    `context: ${deps.state.contextTokens.toLocaleString()} / ${deps.state.contextLimit.toLocaleString()} (${(deps.state.contextPercent * 100).toFixed(1)}%)`,
    `working set: ${profile.canonicalWorkingSetTokens.toLocaleString()} · auto compact at ${profile.autoCompactAtTokens.toLocaleString()}`,
    `permissions: ${deps.permissionProfile}`,
    `plan items: ${deps.todos.length}`,
    `artifacts: ${deps.artifacts.length}`,
    `skills loaded: ${deps.loadedSkills.size}`,
    `provider sessions: ${deps.remoteSessions.size}`,
    `background queue: ${queue}`,
    `background jobs: ${deps.backgroundJobs.length}`,
    `lsp: ${lspState.connected.length}/${lspState.available.length} connected`,
  ].join('\n');
};

export const formatContextSummary = async (deps: SystemCommandDeps): Promise<string> => {
  const changedFiles = await deps.getChangedFiles(12);
  let briefingSummary = 'none';
  let briefingSteps: string[] = [];
  try {
    const briefing = await deps.getBriefingSummary();
    if (briefing) {
      briefingSummary = briefing.summary;
      briefingSteps = briefing.nextSteps.slice(0, 5);
    }
  } catch {
    briefingSummary = 'unavailable';
  }

  const activeAgents = deps.agentActivities
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6)
    .map((item) => {
      const scope = [item.mode ? HARNESS_MODES[item.mode].label : item.label, item.purpose]
        .filter((part): part is string => Boolean(part))
        .join(' · ');
      return `${scope} · ${item.status}${item.detail ? ` · ${previewText(item.detail, 120)}` : ''}`;
    });

  const backgroundJobs = deps.backgroundJobs
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4)
    .map((job) => `${job.label} · ${job.status}${job.detail ? ` · ${previewText(job.detail, 120)}` : ''}`);
  const artifacts = deps.artifacts.slice(0, 6).map((artifact) => formatArtifactContextLine(artifact as never, 180));

  return [
    'Context Snapshot',
    '',
    'What ddudu currently includes in the live prompt:',
    '- base system prompt + mode prompt addition',
    '- DDUDU.md / AGENTS.md / provider instruction files',
    '- global + project rules',
    '- loaded skills',
    '- layered memory',
    '- workflow state (permissions + todo plan)',
    '- dynamic context snapshot (changed files, briefing, uncertainties, active agents, background jobs, workspace)',
    '',
    `Changed files: ${changedFiles.length > 0 ? changedFiles.join(', ') : 'none'}`,
    `Briefing: ${briefingSummary}`,
    ...(briefingSteps.length > 0 ? ['Next steps:', ...briefingSteps.map((step) => `- ${step}`)] : ['Next steps: none']),
    ...(activeAgents.length > 0 ? ['Recent agents:', ...activeAgents.map((entry) => `- ${entry}`)] : ['Recent agents: none']),
    ...(backgroundJobs.length > 0
      ? ['Background jobs:', ...backgroundJobs.map((entry) => `- ${entry}`)]
      : ['Background jobs: none']),
    ...(artifacts.length > 0 ? ['Artifacts:', ...artifacts.map((entry) => `- ${entry}`)] : ['Artifacts: none']),
    `Uncertainties: ${deps.epistemicState.getStats().uncertainties}`,
  ].join('\n');
};

export const formatSkillSummary = async (deps: SystemCommandDeps): Promise<string> => {
  try {
    const loader = new SkillLoader(process.cwd());
    await loader.scan();
    const skills = loader.list();
    if (skills.length === 0) {
      return 'No skills discovered.';
    }

    return [
      'Skills',
      ...skills.slice(0, 12).map((skill) => {
        const loaded = deps.loadedSkills.has(skill.name) ? 'loaded' : 'available';
        return `${skill.name} · ${loaded} · ${skill.description}`;
      }),
    ].join('\n');
  } catch (error: unknown) {
    return `Skill scan failed: ${serializeError(error)}`;
  }
};

export const loadSkillSummary = async (name: string, deps: SystemCommandDeps): Promise<string> => {
  try {
    const loader = new SkillLoader(process.cwd());
    await loader.scan();
    const skill = await loader.load(name);
    if (!skill) {
      return `Skill not found: ${name}`;
    }

    deps.loadedSkills.set(skill.name, skill);
    await deps.refreshSystemPrompt();
    deps.scheduleStatePush();
    return `Skill loaded into context: ${skill.name}`;
  } catch (error: unknown) {
    return `Skill load failed: ${serializeError(error)}`;
  }
};

const formatMcpSummary = (deps: SystemCommandDeps): string => {
  const entries = Object.entries(deps.config?.mcp.servers ?? {});
  const paths = getDduduPaths(process.cwd());
  if (entries.length === 0) {
    return [
      'No MCP servers configured.',
      `project config: ${paths.projectConfig}`,
      `global config: ${paths.globalConfig}`,
      'Add servers under mcp.servers in ddudu config, not .claude/, unless you explicitly want Claude Code config.',
    ].join('\n');
  }

  const connected = new Set(deps.mcpManager?.getConnectedServers() ?? []);
  const toolCount = deps.toolRegistry?.list().filter((tool) => tool.name.startsWith('mcp__')).length ?? 0;

  return [
    'MCP servers',
    `project config: ${paths.projectConfig}`,
    `global config: ${paths.globalConfig}`,
    `connected: ${connected.size}/${entries.length}`,
    `tools: ${toolCount}`,
    ...entries.map(([name, config]) => {
      const enabled = config.enabled === false ? 'disabled' : connected.has(name) ? 'connected' : 'disconnected';
      const trust = isTrustTier(config.trust) ? config.trust : 'trusted';
      return `${name} · ${config.command} · ${enabled} · trust=${trust}`;
    }),
  ].join('\n');
};

const formatHookSummary = (deps: SystemCommandDeps): string => {
  const stats = deps.hookRegistry.stats();
  const lines = Object.entries(stats).map(([event, count]) => `${event} · ${count}`);
  return ['Hooks', ...lines].join('\n');
};

export const runMcpCommand = async (args: string[], deps: SystemCommandDeps): Promise<string> => {
  const command = args[0]?.trim().toLowerCase() ?? '';
  if (!command || command === 'status' || command === 'list') {
    return formatMcpSummary(deps);
  }

  if (command === 'path') {
    const paths = getDduduPaths(process.cwd());
    return ['MCP config paths', `project: ${paths.projectConfig}`, `global: ${paths.globalConfig}`].join('\n');
  }

  if (command === 'reload') {
    await deps.reloadMcpRuntime();
    return formatMcpSummary(deps);
  }

  if (command === 'add') {
    const name = args[1]?.trim();
    const executable = args[2]?.trim();
    const commandArgs = args.slice(3).map((value) => value.trim()).filter(Boolean);
    if (!name || !executable) {
      return 'Usage: /mcp add <name> <command> [args...]';
    }
    await setDduduConfigValue(process.cwd(), `mcp.servers.${name}`, {
      command: executable,
      args: commandArgs,
      enabled: true,
    });
    await deps.reloadMcpRuntime();
    return `Added MCP server ${name}.\n\n${formatMcpSummary(deps)}`;
  }

  if (command === 'enable' || command === 'disable') {
    const name = args[1]?.trim();
    if (!name) {
      return `Usage: /mcp ${command} <name>`;
    }
    await deps.setMcpServerEnabled(name, command === 'enable');
    return `${command === 'enable' ? 'Enabled' : 'Disabled'} MCP server ${name}.\n\n${formatMcpSummary(deps)}`;
  }

  if (command === 'remove') {
    const name = args[1]?.trim();
    if (!name) {
      return 'Usage: /mcp remove <name>';
    }
    if (!deps.config?.mcp.servers[name]) {
      return `Unknown MCP server: ${name}`;
    }
    await deleteDduduConfigValue(process.cwd(), `mcp.servers.${name}`);
    await deps.reloadMcpRuntime();
    return `Removed MCP server ${name}.\n\n${formatMcpSummary(deps)}`;
  }

  if (command === 'trust') {
    const name = args[1]?.trim();
    const trust = args[2]?.trim().toLowerCase();
    if (!name || !trust || !isTrustTier(trust)) {
      return 'Usage: /mcp trust <name> <trusted|ask|deny>';
    }
    if (!deps.config?.mcp.servers[name]) {
      return `Unknown MCP server: ${name}`;
    }
    await deps.setMcpServerTrust(name, trust);
    return `Updated MCP trust for ${name} -> ${trust}.\n\n${formatMcpSummary(deps)}`;
  }

  return 'Usage: /mcp [status|list|path|reload|add <name> <command> [args...]|enable <name>|disable <name>|remove <name>|trust <name> <trusted|ask|deny>]';
};

export const runHookCommand = async (args: string[], deps: SystemCommandDeps): Promise<string> => {
  const command = args[0]?.trim().toLowerCase() ?? '';
  if (!command || command === 'status' || command === 'list') {
    return formatHookSummary(deps);
  }

  if (command === 'reload') {
    deps.hookRegistry.clear();
    await loadHookFiles(process.cwd(), deps.hookRegistry as never);
    deps.scheduleStatePush();
    return formatHookSummary(deps);
  }

  return 'Usage: /hook [status|list|reload]';
};

export const runInitSummary = async (): Promise<string> => {
  try {
    const result = await initializeProject();
    if (result.alreadyInitialized) {
      return `Already initialized: ${result.projectDir}`;
    }

    return [`Initialized ${result.projectDir}`, `Created: ${result.created.join(', ')}`].join('\n');
  } catch (error: unknown) {
    return `Init failed: ${serializeError(error)}`;
  }
};
