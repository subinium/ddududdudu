export type ProviderTier = 'cheap' | 'medium' | 'expensive';
export type TabLayout = 'single' | 'vertical' | 'horizontal' | 'grid';
export type CompactionStrategy = 'hierarchical' | 'rolling' | 'full';
export type SessionFormat = 'jsonl';
export type SessionRecordType =
  | 'header'
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'compaction';
export type RoutingPriority = 'cheap' | 'balanced' | 'quality';
export type ToolPolicy = 'inherit' | 'allow' | 'ask' | 'deny';

export interface ModelConfig {
  id: string;
  tier: ProviderTier;
  default?: boolean;
}

export interface ProviderConfig {
  name: string;
  command: string;
  args?: string[];
  detect?: string;
  models: ModelConfig[];
}

export interface ProviderStatus {
  name: string;
  available: boolean;
  commandPath?: string;
  checkedAt: string;
  error?: string;
}

export interface RoutingRule {
  match_task_type?: string;
  match_priority?: RoutingPriority;
  provider: string;
  model?: string;
}

export interface AgentConfig {
  default_provider: string;
  default_model: string;
  max_turns: number;
  timeout_minutes: number;
  routing?: RoutingRule[];
}

export interface TabConfig {
  max_tabs: number;
  default_layout: TabLayout;
  restore_on_start: boolean;
}

export interface CompactionConfig {
  trigger: number;
  strategy: CompactionStrategy;
  preserve_recent_turns: number;
}

export interface SessionConfig {
  format: SessionFormat;
  directory: string;
  auto_save: boolean;
}

export interface OpenclawConfig {
  enabled: boolean;
}

export interface ProviderMap {
  [name: string]: ProviderConfig;
}

export interface PresetConfig {
  providers?: ProviderMap;
  agent?: AgentConfigOverride;
  tabs?: TabConfigOverride;
  compaction?: CompactionConfigOverride;
  session?: SessionConfigOverride;
  openclaw?: OpenclawConfigOverride;
  mode?: NamedMode;
  git_checkpoint?: boolean;
  drift_check?: boolean;
  context_budget?: ContextBudgetConfigOverride;
  tools?: ToolsConfigOverride;
  mcp?: McpConfigOverride;
  skills?: SkillsConfigOverride;
  oracle?: OracleConfigOverride;
  checks?: ChecksConfigOverride;
}

export interface DduduConfig {
  providers: ProviderMap;
  agent: AgentConfig;
  tabs: TabConfig;
  compaction: CompactionConfig;
  session: SessionConfig;
  openclaw: OpenclawConfig;
  mode: NamedMode;
  git_checkpoint: boolean;
  drift_check: boolean;
  context_budget: ContextBudgetConfig;
  tools: ToolsConfig;
  mcp: McpConfig;
  skills: SkillsConfig;
  oracle: OracleConfig;
  checks: ChecksConfig;
  presets?: {
    [name: string]: PresetConfig;
  };
}

export interface AgentConfigOverride {
  default_provider?: string;
  default_model?: string;
  max_turns?: number;
  timeout_minutes?: number;
  routing?: RoutingRule[];
}

export interface TabConfigOverride {
  max_tabs?: number;
  default_layout?: TabLayout;
  restore_on_start?: boolean;
}

export interface CompactionConfigOverride {
  trigger?: number;
  strategy?: CompactionStrategy;
  preserve_recent_turns?: number;
}

export interface SessionConfigOverride {
  format?: SessionFormat;
  directory?: string;
  auto_save?: boolean;
}

export interface OpenclawConfigOverride {
  enabled?: boolean;
}

export interface DduduConfigOverride {
  providers?: ProviderMap;
  agent?: AgentConfigOverride;
  tabs?: TabConfigOverride;
  compaction?: CompactionConfigOverride;
  session?: SessionConfigOverride;
  openclaw?: OpenclawConfigOverride;
  mode?: NamedMode;
  git_checkpoint?: boolean;
  drift_check?: boolean;
  context_budget?: ContextBudgetConfigOverride;
  tools?: ToolsConfigOverride;
  mcp?: McpConfigOverride;
  skills?: SkillsConfigOverride;
  oracle?: OracleConfigOverride;
  checks?: ChecksConfigOverride;
  presets?: {
    [name: string]: PresetConfig;
  };
}

export interface SessionHeader {
  id: string;
  createdAt: string;
  title?: string;
  parentId?: string;
  provider?: string;
  model?: string;
  metadata?: {
    [key: string]: unknown;
  };
}

export interface SessionEntry {
  type: SessionRecordType;
  timestamp: string;
  data: {
    [key: string]: unknown;
  };
}

export interface SessionCreateOptions {
  title?: string;
  parentId?: string;
  provider?: string;
  model?: string;
  metadata?: {
    [key: string]: unknown;
  };
}

export interface LoadedSession {
  header: SessionHeader;
  entries: SessionEntry[];
}

export interface SessionListItem {
  id: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  entryCount: number;
  parentId?: string;
  title?: string;
}

export interface ProviderTask {
  taskType?: string;
  preferredProvider?: string;
  preferredModel?: string;
  priority?: RoutingPriority;
  requireAvailable?: boolean;
}

export interface ProviderRoute {
  provider: ProviderConfig;
  model: ModelConfig;
  reason: string;
}

export type NamedMode = 'jennie' | 'lisa' | 'rosé' | 'jisoo';
export type ToolPermission = 'auto' | 'ask' | 'deny';

export interface ToolsConfig {
  permission: ToolPermission;
  toolbox_dirs: string[];
  policies?: Record<string, ToolPolicy>;
}

export interface McpConfig {
  servers: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabled?: boolean;
  }>;
}

export interface SkillsConfig {
  dirs: string[];
}

export interface OracleConfig {
  model: string;
  enabled: boolean;
}

export interface ChecksConfig {
  dirs: string[];
}

export interface ContextBudgetConfig {
  auto_detect: boolean;
  warn_at: number;
}

export interface ToolsConfigOverride {
  permission?: ToolPermission;
  toolbox_dirs?: string[];
  policies?: Record<string, ToolPolicy>;
}

export interface McpConfigOverride {
  servers?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabled?: boolean;
  }>;
}

export interface SkillsConfigOverride {
  dirs?: string[];
}

export interface OracleConfigOverride {
  model?: string;
  enabled?: boolean;
}

export interface ChecksConfigOverride {
  dirs?: string[];
}

export interface ContextBudgetConfigOverride {
  auto_detect?: boolean;
  warn_at?: number;
}
