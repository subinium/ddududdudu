import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';

import type { McpConfig, ToolsConfig, TrustTier } from './types.js';

export type ToolRiskLevel = 'read' | 'write' | 'dangerous';
export type ToolRiskConcern =
  | 'shell'
  | 'network'
  | 'secret'
  | 'destructive'
  | 'delegate'
  | 'external';

export interface ShellCommandRisk {
  level: ToolRiskLevel;
  concerns: ToolRiskConcern[];
  hardBlockReason?: string;
}

export interface ToolRiskAssessment {
  level: ToolRiskLevel;
  concerns: ToolRiskConcern[];
  hardBlockReason?: string;
}

export interface TrustBoundaryAssessment {
  concerns: ToolRiskConcern[];
  requiresApproval: boolean;
  hardBlockReason?: string;
  detail?: string;
}

const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ');

const hasPattern = (command: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(command));

const DESTRUCTIVE_HARD_BLOCKS: RegExp[] = [
  /(?:^|\s)rm\s+-rf\s+\/(?:\s|$)/i,
  /(?:^|\s)rm\s+-rf\s+~(?:\/|\s|$)/i,
  /curl\b[^|\n\r]*\|\s*(?:sh|bash|zsh)\b/i,
  /wget\b[^|\n\r]*-O-\s*\|\s*(?:sh|bash|zsh)\b/i,
  /(?:^|\s)(?:mkfs|fdisk|diskutil\s+eraseDisk|dd\s+if=.+\s+of=\/dev\/)/i,
  /:\(\)\s*\{\s*:\|\:&\s*\};:/,
  /(?:^|\s)(?:shutdown|reboot|halt|poweroff)\b/i,
];

const NETWORK_PATTERNS: RegExp[] = [
  /(?:^|\s)(?:curl|wget|http|httpie|nc|ncat|telnet)\b/i,
  /(?:^|\s)(?:ssh|scp|sftp|rsync)\b/i,
  /(?:^|\s)git\s+(?:push|fetch|pull|clone|remote)\b/i,
  /(?:^|\s)(?:npm|pnpm|yarn|cargo|pip|twine)\s+publish\b/i,
];

const SECRET_PATTERNS: RegExp[] = [
  /(?:^|\s)security\s+find-(?:generic|internet)-password\b/i,
  /(?:^|\s)(?:printenv|env)\b/i,
  /(?:^|\s)(?:cat|less|more|grep|sed|awk)\b[^\n\r]*(?:\.env\b|\.npmrc\b|id_rsa\b|id_ed25519\b|credentials\b|token\b|secrets?\b|\.claude\b|\.codex\b|\.gemini\b|\.aws\/credentials\b)/i,
  /(?:^|\s)(?:op|pass|gcloud|aws)\b[^\n\r]*(?:secret|token|password|credential)/i,
];

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /(?:^|\s)sudo\b/i,
  /(?:^|\s)rm\s+-rf\b/i,
  /(?:^|\s)(?:chown|chmod)\s+-R\b/i,
  /(?:^|\s)git\s+push\b/i,
];

const uniqueConcerns = (concerns: ToolRiskConcern[]): ToolRiskConcern[] =>
  Array.from(new Set(concerns));

const normalizeHost = (value: string): string => value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');

const escapeRegex = (value: string): string =>
  value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');

const wildcardToRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`, 'i');

const matchHostPattern = (host: string, pattern: string): boolean => {
  const normalizedHost = normalizeHost(host);
  const normalizedPattern = normalizeHost(pattern);
  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix) || normalizedHost === normalizedPattern.slice(2);
  }

  if (normalizedPattern.includes('*')) {
    return wildcardToRegExp(normalizedPattern).test(normalizedHost);
  }

  return normalizedHost === normalizedPattern;
};

const expandPathPattern = (cwd: string, pattern: string): string => {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === '~') {
    return homedir();
  }
  if (trimmed.startsWith('~/')) {
    return resolve(homedir(), trimmed.slice(2));
  }
  if (isAbsolute(trimmed)) {
    return trimmed;
  }
  return trimmed;
};

const matchPathPattern = (cwd: string, targetPath: string, pattern: string): boolean => {
  const absoluteTarget = resolve(cwd, targetPath).replace(/\\/g, '/');
  const relativeTarget = relative(cwd, absoluteTarget).replace(/\\/g, '/');
  const targetBase = basename(absoluteTarget).toLowerCase();
  const expandedPattern = expandPathPattern(cwd, pattern).replace(/\\/g, '/');
  const normalizedPattern = expandedPattern.toLowerCase();
  const matcher = wildcardToRegExp(normalizedPattern);

  if (normalizedPattern.startsWith('/')) {
    return matcher.test(absoluteTarget.toLowerCase())
      || absoluteTarget.toLowerCase().startsWith(`${normalizedPattern}/`);
  }

  return matcher.test(relativeTarget.toLowerCase())
    || matcher.test(targetBase)
    || matcher.test(absoluteTarget.toLowerCase());
};

const addMatches = (values: string[], patterns: string[], matcher: (value: string, pattern: string) => boolean): string[] => {
  const matches = new Set<string>();
  for (const value of values) {
    for (const pattern of patterns) {
      if (matcher(value, pattern)) {
        matches.add(pattern);
      }
    }
  }
  return Array.from(matches);
};

const extractHostsFromText = (input: string): string[] => {
  const hosts = new Set<string>();
  for (const match of input.matchAll(/\bhttps?:\/\/([a-z0-9.-]+)(?::\d+)?/gi)) {
    if (match[1]) {
      hosts.add(normalizeHost(match[1]));
    }
  }
  for (const match of input.matchAll(/\bgit@([a-z0-9.-]+):/gi)) {
    if (match[1]) {
      hosts.add(normalizeHost(match[1]));
    }
  }
  for (const match of input.matchAll(/\b(?:ssh|scp|sftp|rsync)\b[^\n\r]*?(?:[a-z0-9._-]+@)?([a-z0-9.-]+\.[a-z]{2,})\b/gi)) {
    if (match[1]) {
      hosts.add(normalizeHost(match[1]));
    }
  }
  return Array.from(hosts);
};

const extractToolHosts = (name: string, input: Record<string, unknown>): string[] => {
  if (name === 'web_fetch') {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!url) {
      return [];
    }
    try {
      return [normalizeHost(new URL(url).hostname)];
    } catch {
      return extractHostsFromText(url);
    }
  }

  if (name === 'web_search') {
    return ['duckduckgo.com'];
  }

  if (name === 'bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    return extractHostsFromText(command);
  }

  return [];
};

const extractToolPaths = (cwd: string, name: string, input: Record<string, unknown>): string[] => {
  const keys = ['path', 'file_path'];
  const values = keys
    .map((key) => input[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => resolve(cwd, value));

  if (name === 'list_dir' || name === 'read_file' || name === 'write_file' || name === 'edit_file' || name === 'grep' || name === 'glob') {
    return values;
  }

  if (name === 'bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    return addMatches([command], DEFAULT_PROTECTED_PATH_HINTS, (value, pattern) =>
      value.toLowerCase().includes(pattern.toLowerCase()),
    ).map((pattern) => expandPathPattern(cwd, pattern));
  }

  return values;
};

const extractProtectedEnvHits = (name: string, input: Record<string, unknown>, protectedEnv: string[]): string[] => {
  if (name !== 'bash') {
    return [];
  }

  const command = typeof input.command === 'string' ? input.command : '';
  const normalizedCommand = command.toLowerCase();
  return protectedEnv.filter((entry) => {
    const normalized = entry.toLowerCase();
    return normalizedCommand.includes(`$${normalized}`) || normalizedCommand.includes(normalized);
  });
};

const resolveMcpTrustTier = (name: string, mcp: McpConfig): { server: string; tier: TrustTier } | null => {
  if (!name.startsWith('mcp__')) {
    return null;
  }

  const rest = name.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  if (separator <= 0) {
    return null;
  }

  const server = rest.slice(0, separator);
  const tier = mcp.servers[server]?.trust ?? 'trusted';
  return { server, tier };
};

const DEFAULT_PROTECTED_PATH_HINTS = ['.env', '.ssh', '.aws', '.claude', '.codex', '.gemini', '.npmrc', '.pypirc'];

export const analyzeShellCommand = (command: string): ShellCommandRisk => {
  const normalized = normalize(command);
  const concerns: ToolRiskConcern[] = ['shell'];

  if (normalized.length === 0) {
    return { level: 'dangerous', concerns };
  }

  if (hasPattern(normalized, NETWORK_PATTERNS)) {
    concerns.push('network');
  }
  if (hasPattern(normalized, SECRET_PATTERNS)) {
    concerns.push('secret');
  }
  if (hasPattern(normalized, DESTRUCTIVE_PATTERNS)) {
    concerns.push('destructive');
  }

  const hardBlockPattern = DESTRUCTIVE_HARD_BLOCKS.find((pattern) => pattern.test(normalized));
  if (hardBlockPattern) {
    return {
      level: 'dangerous',
      concerns: uniqueConcerns([...concerns, 'destructive']),
      hardBlockReason: `Blocked shell command by trust policy: ${normalized}`,
    };
  }

  return {
    level: concerns.length === 1 ? 'write' : 'dangerous',
    concerns: uniqueConcerns(concerns),
  };
};

export const analyzeToolRisk = (
  name: string,
  input: Record<string, unknown>,
): ToolRiskAssessment => {
  if (
    name === 'read_file' ||
    name === 'list_dir' ||
    name === 'grep' ||
    name === 'glob' ||
    name === 'web_fetch' ||
    name === 'web_search' ||
    name === 'docs_lookup' ||
    name === 'repo_map' ||
    name === 'symbol_search' ||
    name === 'definition_search' ||
    name === 'reference_search' ||
    name === 'reference_hotspots' ||
    name === 'changed_files' ||
    name === 'file_importance' ||
    name === 'codebase_search' ||
    name === 'git_status' ||
    name === 'git_diff' ||
    name === 'ask_question' ||
    name === 'oracle' ||
    name === 'lint_runner' ||
    name === 'test_runner' ||
    name === 'build_runner' ||
    name === 'verify_changes'
  ) {
    const concerns: ToolRiskConcern[] =
      name === 'web_fetch' || name === 'web_search'
        ? ['network', 'external']
        : [];
    return { level: 'read', concerns };
  }

  if (name === 'patch_apply') {
    const checkOnly = input.check === true;
    return { level: checkOnly ? 'read' : 'write', concerns: [] };
  }

  if (name === 'memory') {
    const action = typeof input.action === 'string' ? input.action : 'read';
    return { level: action === 'read' ? 'read' : 'write', concerns: [] };
  }

  if (name === 'write_file' || name === 'edit_file' || name === 'update_plan') {
    return { level: 'write', concerns: [] };
  }

  if (name === 'task') {
    return { level: 'dangerous', concerns: ['delegate'] };
  }

  if (name.startsWith('mcp__')) {
    return { level: 'dangerous', concerns: ['external'] };
  }

  if (name === 'bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    return analyzeShellCommand(command);
  }

  return { level: 'dangerous', concerns: ['external'] };
};

export const shouldPromptForRisk = (
  permissionProfile: 'plan' | 'ask' | 'workspace-write' | 'permissionless',
  assessment: ToolRiskAssessment,
): boolean => {
  if (permissionProfile === 'plan') {
    return assessment.level !== 'read';
  }

  if (permissionProfile === 'ask') {
    return assessment.level !== 'read';
  }

  if (permissionProfile === 'workspace-write') {
    return (
      assessment.level === 'dangerous'
      || assessment.concerns.includes('network')
      || assessment.concerns.includes('secret')
      || assessment.concerns.includes('destructive')
      || assessment.concerns.includes('delegate')
      || assessment.concerns.includes('external')
    );
  }

  return false;
};

export const analyzeTrustBoundary = (
  cwd: string,
  name: string,
  input: Record<string, unknown>,
  tools: ToolsConfig,
  mcp: McpConfig,
): TrustBoundaryAssessment => {
  const concerns: ToolRiskConcern[] = [];
  const details: string[] = [];
  let requiresApproval = false;

  const mcpTrust = resolveMcpTrustTier(name, mcp);
  if (mcpTrust) {
    concerns.push('external');
    if (mcpTrust.tier === 'deny') {
      return {
        concerns: uniqueConcerns(concerns),
        requiresApproval: false,
        hardBlockReason: `Blocked ${name}: MCP server ${mcpTrust.server} is denied by trust policy.`,
        detail: `mcp:${mcpTrust.server}`,
      };
    }
    if (mcpTrust.tier === 'ask') {
      requiresApproval = true;
      details.push(`mcp:${mcpTrust.server}`);
    }
  }

  const hosts = extractToolHosts(name, input);
  if (hosts.length > 0) {
    concerns.push('network');
    const deniedHosts = addMatches(hosts, tools.network.denied_hosts, matchHostPattern);
    if (deniedHosts.length > 0) {
      return {
        concerns: uniqueConcerns(concerns),
        requiresApproval: false,
        hardBlockReason: `Blocked ${name}: host denied by trust policy (${deniedHosts.join(', ')}).`,
        detail: `hosts:${hosts.join(', ')}`,
      };
    }

    const allowedHosts = tools.network.allowed_hosts;
    const untrustedHosts = allowedHosts.length > 0
      ? hosts.filter((host) => !allowedHosts.some((pattern) => matchHostPattern(host, pattern)))
      : hosts;

    if (
      untrustedHosts.length > 0
      && (tools.network.ask_on_new_host || allowedHosts.length > 0)
    ) {
      requiresApproval = true;
      details.push(`hosts:${untrustedHosts.join(', ')}`);
    }
  }

  const toolPaths = extractToolPaths(cwd, name, input);
  const protectedPaths = addMatches(toolPaths, tools.secrets.protected_paths, (value, pattern) =>
    matchPathPattern(cwd, value, pattern),
  );
  if (protectedPaths.length > 0) {
    concerns.push('secret');
    requiresApproval = true;
    details.push(`paths:${protectedPaths.join(', ')}`);
  }

  const protectedEnv = extractProtectedEnvHits(name, input, tools.secrets.protected_env);
  if (protectedEnv.length > 0) {
    concerns.push('secret');
    requiresApproval = true;
    details.push(`env:${protectedEnv.join(', ')}`);
  }

  return {
    concerns: uniqueConcerns(concerns),
    requiresApproval,
    detail: details.length > 0 ? details.join(' · ') : undefined,
  };
};
