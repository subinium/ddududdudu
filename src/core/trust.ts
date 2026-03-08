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
    name === 'repo_map' ||
    name === 'symbol_search' ||
    name === 'definition_search' ||
    name === 'reference_search' ||
    name === 'reference_hotspots' ||
    name === 'changed_files' ||
    name === 'codebase_search' ||
    name === 'ask_question' ||
    name === 'oracle'
  ) {
    return { level: 'read', concerns: [] };
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
