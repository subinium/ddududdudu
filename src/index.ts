#!/usr/bin/env node

import { parseArgs, type ParsedCommand } from './cli.js';
import { discoverAllProviders } from './auth/discovery.js';
import { initializeProject } from './core/project-init.js';
import { DIM, GREEN, PINK, RED, RESET } from './tui/colors.js';

const printUsage = (): void => {
  const isTTY = process.stdout.isTTY ?? false;
  const P = isTTY ? '\x1b[38;2;249;76;132m' : '';
  const PL = isTTY ? '\x1b[38;2;255;154;190m' : '';
  const D = isTTY ? '\x1b[2m' : '';
  const X = isTTY ? '\x1b[0m' : '';

  const usage = [
    '',
    `  ${P}♪ DDUDUDDUDU${X}  ${D}v0.1.0${X}`,
    `  ${D}Multi-Agent Orchestration CLI${X}`,
    '',
    `${PL}Usage${X}`,
    `  ${P}ddudu${X}                       ${D}Launch TUI${X}`,
    `  ${P}ddudu init${X}                  ${D}Initialize project${X}`,
    `  ${P}ddudu run${X} "PROMPT"           ${D}Run single prompt${X}`,
    `  ${P}ddudu run${X} --provider NAME    ${D}Use specific provider${X}`,
    `  ${P}ddudu doctor${X}                ${D}Check environment${X}`,
    `  ${P}ddudu provider${X} list|check    ${D}Manage providers${X}`,
    `  ${P}ddudu config${X} show|set        ${D}Configuration${X}`,
    `  ${P}ddudu session${X} list|resume    ${D}Session management${X}`,
    '',
    `${PL}Shortcuts (TUI)${X}`,
    `  Shift+Tab  cycle mode   Esc  interrupt`,
    `  Ctrl+J     newline      Enter submit`,
    '',
    `  ${D}https://github.com/subinium/ddududdudu${X}`,
    '',
  ];

  process.stdout.write(`${usage.join('\n')}\n`);
};

const readVersion = async (): Promise<string> => {
  const { readFile } = await import('node:fs/promises');
  const packagePath = new URL('../package.json', import.meta.url);
  const raw = await readFile(packagePath, 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw new Error('package.json version is missing');
  }

  return parsed.version;
};

const handleInit = async (flags: Record<string, string | boolean>): Promise<void> => {
  const preset = typeof flags.preset === 'string' ? flags.preset : null;
  const result = await initializeProject(process.cwd(), preset);

  if (result.alreadyInitialized) {
    process.stdout.write(`Already initialized: ${result.projectDir}\n`);
    return;
  }

  process.stdout.write(`Initialized ${result.projectDir}\n`);
  process.stdout.write(`Created: ${result.created.join(', ')}\n`);
};

const ensurePrompt = (args: string[]): string => {
  const prompt = args.join(' ').trim();
  if (prompt.length === 0) {
    throw new Error('run requires a prompt string');
  }

  return prompt;
};

const checkCommandAvailable = async (command: string): Promise<boolean> => {
  const { execFile } = await import('node:child_process');

  return new Promise<boolean>((resolve) => {
    execFile('which', [command], (error) => {
      resolve(!error);
    });
  });
};

const handleRun = async (args: string[], flags: Record<string, string | boolean>): Promise<void> => {
  const prompt = ensurePrompt(args);
  const configModule = await import('./core/config.js');
  const config = await configModule.loadConfig();
  const requestedProvider = typeof flags.provider === 'string' ? flags.provider : undefined;
  const providerName = requestedProvider ?? config.agent.default_provider;
  const provider = config.providers[providerName];

  if (!provider) {
    throw new Error(`Unknown provider: ${providerName}`);
  }

  const available = await checkCommandAvailable(provider.command);
  if (!available) {
    throw new Error(`Provider command not found: ${provider.command}`);
  }

  const { spawn } = await import('node:child_process');
  const proc = spawn(provider.command, [...(provider.args ?? []), prompt], {
    stdio: 'inherit',
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code: number | null) => {
      resolve(code ?? 0);
    });
  });

  process.exitCode = exitCode;
};

const loadMergedConfigText = async (): Promise<string> => {
  const configModule = await import('./core/config.js');
  const yamlModule = await import('yaml');
  const config = await configModule.loadConfig();
  return yamlModule.stringify(config);
};

const parseConfigValue = (value: string): unknown => {
  const trimmed = value.trim();
  if (trimmed === 'true') {
    return true;
  }

  if (trimmed === 'false') {
    return false;
  }

  if (trimmed === 'null') {
    return null;
  }

  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric) && trimmed.length > 0) {
    return numeric;
  }

  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const setNestedValue = (target: Record<string, unknown>, keyPath: string, value: unknown): void => {
  const keys = keyPath.split('.').filter((segment: string) => segment.length > 0);
  if (keys.length === 0) {
    throw new Error('config key cannot be empty');
  }

  let cursor: Record<string, unknown> = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    const current = cursor[key];
    if (!isRecord(current)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }

  cursor[keys[keys.length - 1]] = value;
};

const handleConfig = async (parsed: ParsedCommand): Promise<void> => {
  if (parsed.subcommand === 'show') {
    process.stdout.write(`${await loadMergedConfigText()}\n`);
    return;
  }

  if (parsed.subcommand === 'set') {
    const [key, value] = parsed.args;
    if (!key || value === undefined) {
      throw new Error('config set requires KEY and VALUE');
    }

    const { access, mkdir, readFile, writeFile } = await import('node:fs/promises');
    const { constants } = await import('node:fs');
    const { resolve } = await import('node:path');
    const yamlModule = await import('yaml');

    const configDir = resolve(process.cwd(), '.ddudu');
    const configPath = resolve(configDir, 'config.yaml');
    await mkdir(configDir, { recursive: true });

    let raw = '';
    try {
      await access(configPath, constants.R_OK);
      raw = await readFile(configPath, 'utf8');
    } catch {
      raw = '';
    }

    const parsedYaml = raw.trim().length > 0 ? (yamlModule.parse(raw) as unknown) : {};
    const target = isRecord(parsedYaml) ? parsedYaml : {};
    setNestedValue(target, key, parseConfigValue(value));
    await writeFile(configPath, yamlModule.stringify(target), 'utf8');
    process.stdout.write(`Updated ${key}\n`);
    return;
  }

  throw new Error('Unknown config subcommand');
};

interface ProviderCheckResult {
  name: string;
  command: string;
  available: boolean;
}

const getProviderChecks = async (): Promise<ProviderCheckResult[]> => {
  const configModule = await import('./core/config.js');
  const config = await configModule.loadConfig();

  const checks = await Promise.all(
    Object.values(config.providers).map(async (provider) => ({
      name: provider.name,
      command: provider.command,
      available: await checkCommandAvailable(provider.command),
    }))
  );

  return checks;
};

const handleProvider = async (parsed: ParsedCommand): Promise<void> => {
  const checks = await getProviderChecks();

  if (parsed.subcommand === 'list') {
    for (const check of checks) {
      const status = check.available ? 'available' : 'missing';
      process.stdout.write(`${check.name}\t${check.command}\t${status}\n`);
    }
    return;
  }

  if (parsed.subcommand === 'check') {
    const missing = checks.filter((item: ProviderCheckResult) => !item.available);
    for (const check of checks) {
      process.stdout.write(`${check.name}: ${check.available ? 'ok' : 'missing'}\n`);
    }
    if (missing.length > 0) {
      throw new Error(`Missing providers: ${missing.map((item: ProviderCheckResult) => item.name).join(', ')}`);
    }
    return;
  }

  throw new Error('Unknown provider subcommand');
};

const resolveSessionDir = async (): Promise<string> => {
  const { resolve } = await import('node:path');
  const configModule = await import('./core/config.js');
  const config = await configModule.loadConfig();
  return resolve(process.cwd(), config.session.directory);
};

const handleSession = async (parsed: ParsedCommand): Promise<void> => {
  const { access, readdir } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const sessionDir = await resolveSessionDir();

  try {
    await access(sessionDir, constants.R_OK);
  } catch {
    process.stdout.write('No sessions directory found\n');
    return;
  }

  const entries = await readdir(sessionDir, { withFileTypes: true });
  const sessionIds = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name.slice(0, -'.jsonl'.length));

  if (parsed.subcommand === 'list') {
    if (sessionIds.length === 0) {
      process.stdout.write('No sessions\n');
      return;
    }
    for (const id of sessionIds) {
      process.stdout.write(`${id}\n`);
    }
    return;
  }

  if (parsed.subcommand === 'resume') {
    const [id] = parsed.args;
    if (!id) {
      throw new Error('session resume requires ID');
    }
    if (!sessionIds.includes(id)) {
      throw new Error(`Session not found: ${id}`);
    }

    const { startNativeTui } = await import('./tui/native/launcher.js');
    await startNativeTui({ resumeSessionId: id });
    return;
  }

  throw new Error('Unknown session subcommand');
};

type AuthProviderName = 'claude' | 'codex' | 'gemini';

const AUTH_PROVIDERS: AuthProviderName[] = ['claude', 'codex', 'gemini'];

const AUTH_SETUP_HINTS: Record<AuthProviderName, string> = {
  claude: "Run 'claude auth login' or set ANTHROPIC_API_KEY",
  codex: "Run 'codex login' or set OPENAI_API_KEY",
  gemini: 'Set GEMINI_API_KEY or configure ~/.gemini/oauth_creds.json',
};

const handleAuthOutput = async (showSetupHints: boolean): Promise<void> => {
  const isTTY = process.stdout.isTTY ?? false;
  const pink = isTTY ? PINK : '';
  const dim = isTTY ? DIM : '';
  const green = isTTY ? GREEN : '';
  const red = isTTY ? RED : '';
  const reset = isTTY ? RESET : '';

  process.stdout.write(`${pink}♪ ddudu auth${reset}\n\n`);
  const discovered = await discoverAllProviders();

  let configuredCount = 0;
  for (const provider of AUTH_PROVIDERS) {
    const auth = discovered.get(provider);
    if (auth) {
      configuredCount += 1;
      process.stdout.write(`${green}✓${reset} ${provider}: authenticated ${dim}(${auth.source})${reset}\n`);
      continue;
    }

    process.stdout.write(`${red}✗${reset} ${provider}: not configured\n`);
    if (showSetupHints) {
      process.stdout.write(`  ${dim}${AUTH_SETUP_HINTS[provider]}${reset}\n`);
    }
  }

  process.stdout.write(`\n${configuredCount}/3 providers configured\n`);
};

const handleAuth = async (parsed: ParsedCommand): Promise<void> => {
  if (!parsed.subcommand || parsed.subcommand === 'login') {
    await handleAuthOutput(true);
    return;
  }

  if (parsed.subcommand === 'status') {
    await handleAuthOutput(false);
    return;
  }

  throw new Error('Unknown auth subcommand');
};

const handleDoctor = async (): Promise<void> => {
  await loadMergedConfigText();
  const checks = await getProviderChecks();
  const availableProviders = checks.filter((check: ProviderCheckResult) => check.available).length;
  const tokenEnvNames = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'];
  const tokensFound = tokenEnvNames.filter((name: string) => Boolean(process.env[name]));
  const { discoverAllProviders } = await import('./auth/discovery.js');
  const providers = await discoverAllProviders();

  process.stdout.write(`Config: ok\n`);
  process.stdout.write(`Providers: ${availableProviders}/${checks.length} available\n`);
  process.stdout.write(`Tokens: ${tokensFound.length > 0 ? tokensFound.join(', ') : 'none'}\n`);
  for (const [name, auth] of providers) {
    process.stdout.write(`${name}: ${auth.source} ✓\n`);
  }

  if (availableProviders === 0) {
    throw new Error('No provider commands detected');
  }
};

const handleStatus = async (): Promise<void> => {
  const multiplexerModule = await import('./multiplexer/detect.js');
  const mux = multiplexerModule.getMultiplexer();
  let paneCount = 0;
  try {
    paneCount = (await mux.listPanes()).length;
  } catch {
    paneCount = 0;
  }

  process.stdout.write(`backend: ${mux.name}\n`);
  process.stdout.write(`panes: ${paneCount}\n`);
  process.stdout.write(`cwd: ${process.cwd()}\n`);
};

const handleTab = async (parsed: ParsedCommand): Promise<void> => {
  if (parsed.subcommand === 'new') {
    const [name] = parsed.args;
    const tabName = name ?? 'new-tab';
    throw new Error(`No running TUI instance for tab '${tabName}'. Start ddudu first.`);
  }

  if (parsed.subcommand === 'list') {
    throw new Error('No running TUI instance. Start ddudu first.');
  }

  throw new Error('Unknown tab subcommand');
};

const startTui = async (): Promise<void> => {
  const { startNativeTui } = await import('./tui/native/launcher.js');
  await startNativeTui();
};

const runCommand = async (parsed: ParsedCommand): Promise<void> => {
  if (parsed.command === 'help') {
    printUsage();
    return;
  }

  if (parsed.command === 'version') {
    process.stdout.write(`${await readVersion()}\n`);
    return;
  }

  if (parsed.command === 'tui') {
    await startTui();
    return;
  }

  if (parsed.command === 'bridge') {
    const { runNativeBridge } = await import('./tui/native/bridge.js');
    await runNativeBridge();
    return;
  }

  if (parsed.command === 'init') {
    await handleInit(parsed.flags);
    return;
  }

  if (parsed.command === 'run') {
    await handleRun(parsed.args, parsed.flags);
    return;
  }

  if (parsed.command === 'tab') {
    await handleTab(parsed);
    return;
  }

  if (parsed.command === 'config') {
    await handleConfig(parsed);
    return;
  }

  if (parsed.command === 'provider') {
    await handleProvider(parsed);
    return;
  }

  if (parsed.command === 'session') {
    await handleSession(parsed);
    return;
  }

  if (parsed.command === 'auth') {
    await handleAuth(parsed);
    return;
  }

  if (parsed.command === 'doctor') {
    await handleDoctor();
    return;
  }

  if (parsed.command === 'status') {
    await handleStatus();
    return;
  }

  throw new Error(`Unknown command: ${parsed.command}`);
};

const main = async (): Promise<void> => {
  const parsed = parseArgs(process.argv.slice(2));
  await runCommand(parsed);
};

main().catch((error: unknown) => {
  if (error instanceof Error) {
    process.stderr.write(`ddudu: ${error.message}\n`);
  } else {
    process.stderr.write('ddudu: unknown error\n');
  }
  process.exitCode = 1;
});
