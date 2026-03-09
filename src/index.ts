#!/usr/bin/env node

import { parseArgs, type ParsedCommand } from './cli.js';
import { discoverAllProviders } from './auth/discovery.js';
import {
  AUTH_PROVIDERS,
  AUTH_PROVIDER_DESCRIPTIONS,
  AUTH_SETUP_HINTS,
  buildAuthModeHighlights,
  buildGeminiLoginHelp,
  buildResolvedModeSummary,
  resolveRequestedAuthProvider,
  type AuthProviderName,
} from './auth/login.js';
import { getAuthStorePath, setStoredProviderAuth } from './auth/store.js';
import { initializeProject } from './core/project-init.js';
import { DIM, GREEN, PINK, RED, RESET } from './tui/colors.js';

const DISPLAY_VERSION = process.env.DDUDU_VERSION ?? '0.3.1';

const previewText = (value: string, maxLength: number = 68): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const formatSessionLabel = (session: {
  id: string;
  updatedAt: string;
  entryCount: number;
  title?: string;
  provider?: string;
  model?: string;
  preview?: string;
}): string => {
  const title = session.title || session.preview || 'untitled session';
  const runtime = [session.provider, session.model].filter((part): part is string => Boolean(part)).join(' · ');
  const updated = session.updatedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  const parts = [
    previewText(title, 56),
    runtime ? previewText(runtime, 40) : null,
    `${session.entryCount} entries`,
    updated,
    `#${session.id.slice(0, 8)}`,
  ].filter((part): part is string => Boolean(part));
  return parts.join('  ·  ');
};

const formatProviderChoice = (
  provider: AuthProviderName,
  connected: boolean,
): string => {
  const status = connected ? 'connected' : 'new';
  return `${provider.toUpperCase()}  ${DIM}${status}${RESET}`;
};

const printUsage = (): void => {
  const isTTY = process.stdout.isTTY ?? false;
  const P = isTTY ? '\x1b[38;2;249;76;132m' : '';
  const PL = isTTY ? '\x1b[38;2;255;154;190m' : '';
  const D = isTTY ? '\x1b[2m' : '';
  const X = isTTY ? '\x1b[0m' : '';

  const usage = [
    '',
    `  ${P}♪ DDUDUDDUDU${X}  ${D}v${DISPLAY_VERSION}${X}`,
    `  ${D}Multi-Agent Orchestration CLI${X}`,
    '',
    `${PL}Usage${X}`,
    `  ${P}ddudu${X}                       ${D}Launch TUI${X}`,
    `  ${P}ddudu init${X}                  ${D}Initialize project${X}`,
    `  ${P}ddudu run${X} "PROMPT"           ${D}Run single prompt${X}`,
    `  ${P}ddudu run${X} --provider NAME    ${D}Use specific provider${X}`,
    `  ${P}ddudu auth${X} [login|status]    ${D}Inspect or refresh provider auth${X}`,
    `  ${P}ddudu doctor${X}                ${D}Check environment${X}`,
    `  ${P}ddudu provider${X} list|check    ${D}Manage providers${X}`,
    `  ${P}ddudu config${X} show|set        ${D}Configuration${X}`,
    `  ${P}ddudu session${X} list|pick|resume|last ${D}Session management${X}`,
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

type AuthLoginMethod = 'vendor' | 'apikey' | 'local';

interface PickerChoice<T> {
  value: T;
  label: string;
  detail?: string;
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
  const { SessionManager } = await import('./core/session.js');
  const sessionDir = await resolveSessionDir();
  const manager = new SessionManager(sessionDir);
  const sessions = await manager.list();

  if (parsed.subcommand === 'list') {
    if (sessions.length === 0) {
      process.stdout.write('No sessions\n');
      return;
    }
    for (const [index, session] of sessions.entries()) {
      process.stdout.write(`${index + 1}. ${formatSessionLabel(session)}\n`);
    }
    return;
  }

  if (parsed.subcommand === 'last') {
    const latest = sessions[0];
    if (!latest) {
      process.stdout.write('No sessions\n');
      return;
    }

    const { startNativeTui } = await import('./tui/native/launcher.js');
    await startNativeTui({ resumeSessionId: latest.id });
    return;
  }

  if (parsed.subcommand === 'pick') {
    if (!(process.stdin.isTTY ?? false) || !(process.stdout.isTTY ?? false)) {
      throw new Error('session pick requires an interactive terminal');
    }

    const latest = sessions.slice(0, 12);
    if (latest.length === 0) {
      process.stdout.write('No sessions\n');
      return;
    }

    const resolved = await promptWithArrowPicker(
      'Resume a saved session',
      latest.map((session) => ({
        value: session,
        label: session.title || session.preview || 'untitled session',
        detail: formatSessionLabel(session),
      })),
      '↑/↓ move · Enter resume · Esc cancel',
    );

    const { startNativeTui } = await import('./tui/native/launcher.js');
    await startNativeTui({ resumeSessionId: resolved.id });
    return;
  }

  if (parsed.subcommand === 'resume') {
    const [id] = parsed.args;
    if (!id) {
      throw new Error('session resume requires ID. Use `ddudu session list` to inspect recent sessions.');
    }
    const resolved = sessions.find((session) => session.id === id || session.id.startsWith(id));
    if (!resolved) {
      throw new Error(`Session not found: ${id}`);
    }

    const { startNativeTui } = await import('./tui/native/launcher.js');
    await startNativeTui({ resumeSessionId: resolved.id });
    return;
  }

  throw new Error('Unknown session subcommand');
};

const handleJob = async (parsed: ParsedCommand): Promise<void> => {
  if (parsed.subcommand !== 'run') {
    throw new Error('Unknown job subcommand');
  }

  const [jobId] = parsed.args;
  if (!jobId) {
    throw new Error('job run requires ID');
  }

  const { runDetachedBackgroundJob } = await import('./core/background-worker.js');
  await runDetachedBackgroundJob(jobId);
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

const runVendorLogin = async (command: string, args: string[]): Promise<void> => {
  const { spawn } = await import('node:child_process');

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: 'inherit',
    });

    proc.on('error', reject);
    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal) {
        reject(new Error(`${command} login terminated by signal ${signal}`));
        return;
      }

      if ((code ?? 0) !== 0) {
        reject(new Error(`${command} login exited with code ${code ?? 0}`));
        return;
      }

      resolve();
    });
  });
};

const withRawMode = async <T>(
  handler: (
    stdin: NodeJS.ReadStream,
    stdout: NodeJS.WriteStream,
    readline: typeof import('node:readline'),
  ) => Promise<T>,
): Promise<T> => {
  if (!(process.stdin.isTTY ?? false) || !(process.stdout.isTTY ?? false)) {
    throw new Error('interactive selection requires a TTY');
  }

  const readline = await import('node:readline');
  const stdin = process.stdin;
  const stdout = process.stdout;
  const setRawMode = typeof stdin.setRawMode === 'function';
  readline.emitKeypressEvents(stdin);
  if (setRawMode) {
    stdin.setRawMode(true);
  }

  try {
    return await handler(stdin, stdout, readline);
  } finally {
    if (setRawMode) {
      stdin.setRawMode(false);
    }
  }
};

const promptWithArrowPicker = async <T>(
  title: string,
  choices: PickerChoice<T>[],
  footer: string,
): Promise<T> => {
  if (choices.length === 0) {
    throw new Error('no choices available');
  }

  return withRawMode<T>((stdin, stdout) => new Promise<T>((resolve, reject) => {
    let activeIndex = 0;
    let renderedLines = 0;

    const render = (): void => {
      if (renderedLines > 0) {
        stdout.write(`\x1b[${renderedLines}A`);
      }

      const lines = [
        `${PINK}♪ ${title}${RESET}`,
        '',
        ...choices.flatMap((choice, index) => {
          const selected = index === activeIndex;
          const marker = selected ? `${PINK}›${RESET}` : ' ';
          const label = selected ? `${PINK}${choice.label}${RESET}` : choice.label;
          const detail = choice.detail ? `${selected ? PINK : DIM}${choice.detail}${RESET}` : null;
          return [
            `  ${marker} ${label}`,
            ...(detail ? [`      ${detail}`] : []),
            '',
          ];
        }),
        '',
        `${DIM}${footer}${RESET}`,
      ];

      stdout.write(lines.map((line) => `\x1b[2K${line}`).join('\n'));
      stdout.write('\n');
      renderedLines = lines.length;
    };

    const cleanup = (): void => {
      stdin.off('keypress', onKeypress);
      stdout.write('\x1b[?25h');
    };

    const finish = (value: T): void => {
      cleanup();
      resolve(value);
    };

    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }): void => {
      if (key.ctrl && key.name === 'c') {
        fail(new Error('cancelled'));
        return;
      }

      if (key.name === 'escape') {
        fail(new Error('cancelled'));
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        activeIndex = activeIndex === 0 ? choices.length - 1 : activeIndex - 1;
        render();
        return;
      }

      if (key.name === 'down' || key.name === 'j') {
        activeIndex = activeIndex === choices.length - 1 ? 0 : activeIndex + 1;
        render();
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        finish(choices[activeIndex]!.value);
      }
    };

    stdout.write('\x1b[?25l');
    render();
    stdin.on('keypress', onKeypress);
  }));
};

const promptForSecret = async (label: string): Promise<string> => {
  return withRawMode<string>((stdin, stdout) => new Promise<string>((resolve, reject) => {
    let value = '';

    const cleanup = (): void => {
      stdin.off('keypress', onKeypress);
      stdout.write('\x1b[?25h');
    };

    const onKeypress = (chunk: string, key: { name?: string; ctrl?: boolean; sequence?: string }): void => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('cancelled'));
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        stdout.write('\n');
        resolve(value.trim());
        return;
      }

      if (key.name === 'backspace') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write('\b \b');
        }
        return;
      }

      if (typeof chunk === 'string' && chunk.length > 0 && !key.ctrl) {
        value += chunk;
        stdout.write('*');
      }
    };

    stdout.write('\x1b[?25l');
    stdout.write(`${PINK}♪ ${label}${RESET}: `);
    stdin.on('keypress', onKeypress);
  }));
};

const promptForAuthProvider = async (): Promise<AuthProviderName> => {
  if (!(process.stdin.isTTY ?? false) || !(process.stdout.isTTY ?? false)) {
    throw new Error('auth login without a provider requires an interactive terminal');
  }

  const discovered = await discoverAllProviders();
  const orderedProviders = [
    ...AUTH_PROVIDERS.filter((provider) => !discovered.has(provider)),
    ...AUTH_PROVIDERS.filter((provider) => discovered.has(provider)),
  ];

  return promptWithArrowPicker(
    'Choose a provider to authenticate',
    orderedProviders.map((provider) => ({
      value: provider,
      label: formatProviderChoice(provider, discovered.has(provider)),
      detail: `${AUTH_PROVIDER_DESCRIPTIONS[provider]} · ${AUTH_SETUP_HINTS[provider]}`,
    })),
    '↑/↓ move · Enter select · Esc cancel',
  );
};

const resolveRequestedAuthMethod = (
  provider: AuthProviderName,
  flags: Record<string, string | boolean>,
): AuthLoginMethod | null => {
  if (flags['api-key'] === true) {
    return 'apikey';
  }

  const rawMethod =
    typeof flags.method === 'string'
      ? flags.method.trim().toLowerCase()
      : typeof flags.m === 'string'
        ? flags.m.trim().toLowerCase()
        : '';

  if (!rawMethod) {
    return null;
  }

  if (rawMethod === 'api' || rawMethod === 'apikey' || rawMethod === 'api-key') {
    return 'apikey';
  }

  if (rawMethod === 'vendor' || rawMethod === 'auth' || rawMethod === 'login') {
    return 'vendor';
  }

  if (provider === 'gemini' && (rawMethod === 'local' || rawMethod === 'existing')) {
    return 'local';
  }

  throw new Error(`Unknown auth method: ${rawMethod}`);
};

const promptForAuthMethod = async (provider: AuthProviderName): Promise<AuthLoginMethod> => {
  const choices: PickerChoice<AuthLoginMethod>[] =
    provider === 'claude'
        ? [
          {
            value: 'vendor',
            label: 'Claude Code login',
            detail: 'reuse local Claude auth',
          },
          {
            value: 'apikey',
            label: 'Anthropic API key',
            detail: 'store in ~/.ddudu/auth.yaml',
          },
        ]
      : provider === 'codex'
        ? [
            {
              value: 'vendor',
              label: 'Codex login',
              detail: 'reuse local Codex auth',
            },
            {
              value: 'apikey',
              label: 'OpenAI API key',
              detail: 'store in ~/.ddudu/auth.yaml',
            },
          ]
        : [
            {
              value: 'apikey',
              label: 'Gemini API key',
              detail: 'store in ~/.ddudu/auth.yaml',
            },
            {
              value: 'local',
              label: 'Reuse local Gemini credentials',
              detail: 'use ~/.gemini/oauth_creds.json',
            },
          ];

  return promptWithArrowPicker(
    `Choose how to authenticate ${provider}`,
    choices,
    '↑/↓ move · Enter select · Esc cancel',
  );
};

const registerApiKey = async (provider: AuthProviderName): Promise<void> => {
  const secretLabel =
    provider === 'claude'
      ? 'Anthropic API key'
      : provider === 'codex'
        ? 'OpenAI API key'
        : 'Gemini API key';
  const token = await promptForSecret(secretLabel);
  if (!token) {
    throw new Error('empty API key');
  }

  const path = await setStoredProviderAuth(provider, {
    token,
    tokenType: 'apikey',
    source: 'ddudu-auth-store',
    label: secretLabel,
  });
  process.stdout.write(`\nStored ${provider} API key in ${path}\n`);
};

const completeAuthLogin = async (
  provider: AuthProviderName,
  method: AuthLoginMethod | null = null,
): Promise<void> => {
  const selectedMethod =
    method ??
    (process.stdin.isTTY && process.stdout.isTTY ? await promptForAuthMethod(provider) : 'vendor');

  if (selectedMethod === 'apikey') {
    if (!(process.stdin.isTTY ?? false) || !(process.stdout.isTTY ?? false)) {
      throw new Error('API key registration requires an interactive terminal');
    }
    await registerApiKey(provider);
  } else if (provider === 'claude') {
    if (!(await checkCommandAvailable('claude'))) {
      throw new Error("Claude CLI not found. Install it first, then run 'ddudu auth login claude'.");
    }

    await runVendorLogin('claude', ['auth', 'login']);
  } else if (provider === 'codex') {
    if (!(await checkCommandAvailable('codex'))) {
      throw new Error("Codex CLI not found. Install it first, then run 'ddudu auth login codex'.");
    }

    await runVendorLogin('codex', ['login']);
  } else if (selectedMethod === 'local') {
    process.stdout.write(`${DIM}Checking existing local Gemini credentials...${RESET}\n`);
  } else {
    process.stdout.write(`${buildGeminiLoginHelp().join('\n')}\n`);
    return;
  }

  const discovered = await discoverAllProviders();
  const auth = discovered.get(provider);
  if (!auth) {
    if (provider === 'gemini' && selectedMethod === 'local') {
      throw new Error('No local Gemini credentials found yet. Set GEMINI_API_KEY or configure ~/.gemini/oauth_creds.json.');
    }
    throw new Error(`${provider} login completed, but ddudu could not rediscover credentials yet.`);
  }

  process.stdout.write(`\nAuthenticated ${provider} via ${auth.source}\n`);
  process.stdout.write(`${AUTH_PROVIDER_DESCRIPTIONS[provider]}\n`);
  const highlights = buildAuthModeHighlights((name) => discovered.has(name));
  if (highlights.length > 0) {
    process.stdout.write('\nMode highlights:\n');
    for (const line of highlights) {
      process.stdout.write(`${line}\n`);
    }
  }
  process.stdout.write('\nResolved mode lineup:\n');
  for (const line of buildResolvedModeSummary((name) => discovered.has(name))) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write('\nNext steps:\n');
  process.stdout.write('  ddudu\n');
  process.stdout.write('  ddudu auth status\n');
  if (selectedMethod === 'apikey') {
    process.stdout.write(`  stored in ${getAuthStorePath()}\n`);
  }
};

const handleAuth = async (parsed: ParsedCommand): Promise<void> => {
  if (!parsed.subcommand) {
    await handleAuthOutput(true);
    return;
  }

  if (parsed.subcommand === 'login') {
    const requested = resolveRequestedAuthProvider(parsed.args, parsed.flags);
    const requestedMethod = requested && requested !== 'all' ? resolveRequestedAuthMethod(requested, parsed.flags) : null;
    if (requested === 'all') {
      for (const provider of AUTH_PROVIDERS) {
        await completeAuthLogin(provider);
      }
      process.stdout.write('\n');
      await handleAuthOutput(false);
      return;
    }

    if (requested) {
      await completeAuthLogin(requested, requestedMethod);
      process.stdout.write('\n');
      await handleAuthOutput(false);
      return;
    }

    const provider = await promptForAuthProvider();
    await completeAuthLogin(provider, resolveRequestedAuthMethod(provider, parsed.flags));
    process.stdout.write('\n');
    await handleAuthOutput(false);
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
  process.stdout.write(`backend: native\n`);
  process.stdout.write(`cwd: ${process.cwd()}\n`);
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

  if (parsed.command === 'job') {
    await handleJob(parsed);
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
